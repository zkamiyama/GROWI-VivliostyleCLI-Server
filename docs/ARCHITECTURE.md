# GROWI ↔ Vivliostyle CLI アーキテクチャ

## 概要
GROWI から送信された Vivliostyle プロジェクトを受け取り、Vivliostyle CLI でビルドし、成果物（PDF など）を提供する HTTP サービス。ジョブ単位で入力・作業領域・成果物を分離し、再取得や診断が容易な構造を採用する。

## 構成要素
- **HTTP API (Express)** – ジョブ登録・ステータス参照・成果物ダウンロード・ログ配信を担当。
- **ジョブストア** – jobs/<jobId> 以下にリクエストスナップショット、job.json（状態）、log.ndjson（構造化ログ）、成果物を保持。
- **ジョブキュー (PQueue)** – VIV_QUEUE_CONCURRENCY（既定 2）で同時実行を制御。ワーカーが ZIP 展開と Vivliostyle CLI 実行を行う。
- **Vivliostyle ランナー** – CLI を子プロセスとして起動し、stdout/stderr をログ化。
- **SSE ブロードキャスタ** – appendLog 時に Server-Sent Events を通じてリアルタイムでログとステータス変更を配信。ジョブ完了時に接続を明示的にクローズ。
- **リバースプロキシ (src/proxyServer.ts)** – http-proxy を用いた薄いプロキシ。TLS 終端や同一オリジン化が必要な場合に利用。

## ジョブフロー
1. **登録** – POST /vivliostyle/jobs（Content-Type: application/json または multipart/form-data）で ZIP を受理。最大サイズは VIV_MAX_ARCHIVE_SIZE_MB（既定 500 MB）。
2. **永続化** – jobs/<jobId> を作成し、source.zip と request.json を書き出す。SSE で queued を配信。
3. **実行** – ワーカーが running に更新。ZIP を展開し node_modules/.bin/vivliostyle build を実行。
4. **ログ中継** – stdout/stderr を NDJSON に追記しつつ GET /vivliostyle/jobs/:jobId/log/stream へ SSE として転送。
5. **成果物収集** – CLI 成功時は output/ に成果物を集約し、succeeded を配信。失敗時はエラーを job.json に記録し failed を配信。
6. **クリーンアップ** – 入力 ZIP と workspace/ を削除（成果物は保持）。ATTACHMENT へ移送後に DELETE /vivliostyle/jobs/:jobId でジョブ一式を削除。

## API サーフェス
- POST /vivliostyle/jobs – application/json で { sourceArchive: base64, cliOptions, metadata } を送信。または multipart/form-data で pageId/pagePath/title/zip を送信。pageId は jobId に正規化。
- GET /vivliostyle/jobs/:jobId – ステータス、タイムスタンプ、成果物一覧、ログ末尾、キュー情報を返す。
- GET /vivliostyle/jobs/:jobId/result – 主要成果物をストリーム返却（?file= で任意ファイル指定）。
- GET /vivliostyle/jobs/:jobId/log – 既存ログ（NDJSON）をまとめて返す。
- GET /vivliostyle/jobs/:jobId/log/stream – SSE。過去ログを即時送信し、以降のログとステータス更新をリアルタイムに配信。ジョブ終了時に complete イベントでクローズ。
- DELETE /vivliostyle/jobs/:jobId – 成果物・ログを含むジョブディレクトリを削除。進行中は 409。

## データ構造
```
jobs/
  {jobId}/
    request.json   # リクエストのスナップショット
    job.json       # 現在のステータス・メタデータ
    source.zip     # アップロードされた ZIP
    workspace/     # 作業用ディレクトリ（完了後に削除）
    output/        # 成果物
    log.ndjson     # ログ（1 行 1 JSON）
```

## エラーハンドリング
- 入力検証失敗（base64 不正、サイズ超過）は 400。
- jobId 競合は 409。
- CLI 異常終了／タイムアウト時は job.json に error を記録し failed を配信。
- キュー処理自体が失敗した場合も queue_failure として記録。
- ジョブ削除時は SSE 接続に complete イベントを送り終了。

## 既定設定
| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| VIV_QUEUE_CONCURRENCY | 2 | 同時に実行するジョブ数 |
| VIV_MAX_ARCHIVE_SIZE_MB | 500 | 受け付ける ZIP の最大サイズ |
| VIV_CLI_TIMEOUT_MS | 600000 | Vivliostyle CLI 実行のタイムアウト（ms） |
| VIV_AUTOCLEANUP_TIMEOUT_MS | 900000 | DELETE が届かない場合に自動削除へ移行するまでの待機時間（ms、0 で無効化） |
| VIV_FRONTEND_PING_URL | （空） | 自動削除前に HEAD するフロントエンドのヘルスチェック URL |
| VIV_FRONTEND_PING_TIMEOUT_MS | 3000 | フロント疎通確認のタイムアウト（ms） |
| VIV_WORKSPACE_DIR | <repo>/jobs | ジョブデータ保存パス |
| VIV_PROXY_TARGET | http://127.0.0.1:4781 | プロキシ経由時の API エンドポイント |
| VIV_PROXY_PORT | 4871 | プロキシ待受ポート |

## 逆プロキシ
src/proxyServer.ts は http-proxy を利用した薄いリバースプロキシ。VIV_PROXY_TARGET を API サーバーに設定し、node dist/proxyServer.js または tsx src/proxyServer.ts で起動する。TLS 終端や同一オリジン要件がある場合はこのプロキシの表側に HTTPS を配置する。

### 注意: ルーティングの仕様
本プロキシは特定パスを振り分ける仕様になっています。
- `/vivliostyle/*` は Vivliostyle CLI サーバへ転送されます（デフォルト `http://127.0.0.1:4781`）。
- それ以外のリクエスト（`/` を含む）は GROWI 本体へ転送されます（デフォルト `http://127.0.0.1:3000`）。

このルールにより、同一オリジンで GROWI と Vivliostyle API を共存させ、Funnel 等で同一オリジン公開をした際に期待どおり動作するようになっています。

## フロントエンド連携メモ
- プラグインは multipart または JSON を選択可能。大容量は multipart が推奨。
- ジョブ登録直後に GET /vivliostyle/jobs/:jobId をポーリング、もしくは GET /vivliostyle/jobs/:jobId/log/stream を接続して SSE で進捗を受信。
- 成果物取得後は DELETE /vivliostyle/jobs/:jobId を呼び、サーバー上の一時ファイルを削除。
- フロント側で failed を受け取った場合は job.json の error を参照して原因を表示する。


## 自動削除の挙動
- SSE ログは `event: jobs`（`[jobs] ...` 形式のメッセージ）として配信されます。
- ジョブ完了時に `VIV_AUTOCLEANUP_TIMEOUT_MS` が 0 より大きければタイマーをセットし、期限までに DELETE が届かなければ `VIV_FRONTEND_PING_URL` へ HEAD を送ってからジョブディレクトリを削除します。
- フロントエンドが DELETE を発行すると `Auto-cleanup timer cancelled` のログが `[jobs]` チャンネルに記録され、タイマーは解除されます。

