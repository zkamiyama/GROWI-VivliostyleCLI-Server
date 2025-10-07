# GROWI ↔ Vivliostyle CLI アーキテクチャ

## 概要
GROWI から送信された Vivliostyle プロジェクトを受け取り、Vivliostyle CLI でビルドし、成果物（PDF など）を提供する HTTP サービス。ジョブ単位で入力・作業領域・成果物を分離し、再取得や診断が容易な構造を採用する。

## 構成要素
- **HTTP API (Express)** – ジョブ登録・ステータス参照・成果物ダウンロード・ログ配信を担当。
- **ジョブストア** – jobs/<jobId> 以下にリクエストスナップショット、job.json（状態）、log.ndjson（構造化ログ）、成果物を保持。
- **ジョブキュー (PQueue)** – VIV_QUEUE_CONCURRENCY（既定 2）で同時実行を制御。ワーカーが ZIP 展開と Vivliostyle CLI 実行を行う。
- **Vivliostyle ランナー** – CLI を子プロセスとして起動し、stdout/stderr をログ化。
- **SSE ブロードキャスタ** – ppendLog 時に Server-Sent Events を通じてリアルタイムでログとステータス変更を配信。ジョブ完了時に接続を明示的にクローズ。
- **リバースプロキシ (src/proxyServer.ts)** – http-proxy を用いた薄いプロキシ。TLS 終端や同一オリジン化が必要な場合に利用。

## ジョブフロー
1. **登録** – POST /api/v1/jobs（JSON + base64）または POST /vivliostyle/jobs（multipart）で ZIP を受理。最大サイズは VIV_MAX_ARCHIVE_SIZE_MB（既定 500 MB）。
2. **永続化** – jobs/<jobId> を作成し、source.zip と equest.json を書き出す。SSE で queued 配信。
3. **実行** – ワーカーが unning に更新。ZIP を展開し 
ode_modules/.bin/vivliostyle build を実行。
4. **ログ中継** – stdout/stderr を NDJSON に追記しつつ GET /api/v1/jobs/:jobId/log/stream へ SSE として転送。
5. **成果物収集** – CLI 成功時は output/ に成果物を集約し、succeeded を配信。失敗時はエラーを job.json に記録し ailed を配信。
6. **クリーンアップ** – 入力 ZIP と workspace/ を削除（成果物は保持）。ATTACHMENT へ移送後に DELETE /api/v1/jobs/:jobId でジョブ一式を削除。

## API サーフェス
- POST /api/v1/jobs – JSON で { sourceArchive: base64, cliOptions, metadata } を送信。
- POST /vivliostyle/jobs – multipart/form-data で pageId/pagePath/title/zip を送信。pageId は jobId に正規化。
- GET /api/v1/jobs/:jobId – ステータス、タイムスタンプ、成果物一覧、ログ末尾、キュー情報を返す。
- GET /api/v1/jobs/:jobId/result – 主要成果物をストリーム返却（?file= で任意ファイル指定）。
- GET /api/v1/jobs/:jobId/log – 既存ログ（NDJSON）をまとめて返す。
- GET /api/v1/jobs/:jobId/log/stream – SSE。過去ログを即時送信し、以降のログとステータス更新をリアルタイムに配信。ジョブ終了時に complete イベントでクローズ。
- DELETE /api/v1/jobs/:jobId – 成果物・ログを含むジョブディレクトリを削除。進行中は 409。

## データ構造
`
jobs/
  {jobId}/
    request.json   # リクエストのスナップショット
    job.json       # 現在のステータス・メタデータ
    source.zip     # アップロードされた ZIP
    workspace/     # 作業用ディレクトリ（完了後に削除）
    output/        # 成果物
    log.ndjson     # ログ（1 行 1 JSON）
`

## エラーハンドリング
- 入力検証失敗（base64 不正、サイズ超過）は 400。
- jobId 競合は 409。
- CLI 異常終了／タイムアウト時は job.json に rror を記録し ailed を配信。
- キュー処理自体が失敗した場合も queue_failure として記録。
- ジョブ削除時は SSE 接続に complete イベントを送り終了。

## 既定設定
| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| VIV_QUEUE_CONCURRENCY | 2 | 同時実行するジョブ数 |
| VIV_MAX_ARCHIVE_SIZE_MB | 500 | 受理する ZIP の最大サイズ |
| VIV_CLI_TIMEOUT_MS | 600000 | Vivliostyle CLI 実行のタイムアウト（ms） |
| VIV_WORKSPACE_DIR | <repo>/jobs | ジョブデータ保存先 |
| VIV_PROXY_TARGET | http://127.0.0.1:4781 | プロキシの転送先（proxyServer 起動時） |
| VIV_PROXY_PORT | 4871 | プロキシ待受ポート |

## 逆プロキシ
src/proxyServer.ts は http-proxy を利用した薄いリバースプロキシ。VIV_PROXY_TARGET を API サーバーに設定し、
ode dist/proxyServer.js または 	sx src/proxyServer.ts で起動する。TLS 終端や同一オリジン要件がある場合はこのプロキシの表側に HTTPS を配置する。

## フロントエンド連携メモ
- プラグインは multipart または JSON を選択可能。大容量は multipart が推奨。
- ジョブ登録直後に GET /api/v1/jobs/:jobId をポーリング、もしくは GET /api/v1/jobs/:jobId/log/stream を接続して SSE で進捗を受信。
- 成果物取得後は DELETE /api/v1/jobs/:jobId を呼び、サーバー上の一時ファイルを削除。
- フロント側で ailed を受け取った場合は job.json の rror を参照して原因を表示する。

