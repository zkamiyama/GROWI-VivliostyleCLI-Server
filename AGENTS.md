# Vivliostyle CLI サーバー エージェント ノート

## 背景
- GROWI プラグインからのリクエストを受け取り、Vivliostyle CLI を実行して公開用成果物（PDF など）を生成する HTTP サービス。
- 各ジョブをサンドボックス化し、入力・出力・ログを一貫して管理しつつ、再ダウンロード・調査ができるようにする。

## 実装方針
- サーバーは Node.js（TypeScript）+ Express で実装し、設定は環境変数で切り替えられるようにする。
- Vivliostyle 実行は p-queue を用いたワーカーで制御し、VIV_QUEUE_CONCURRENCY（既定 2）で同時実行数を制限。
- 入力 ZIP は jobs/<jobId>/source.zip に保存し、作業用ディレクトリに展開後 jobs/<jobId>/workspace を破棄。成果物は jobs/<jobId>/output に保管。
- メタデータや進捗は JSON（job.json）と構造化ログ（NDJSON）に記録し、サーバー再起動後も参照可能にする。
- Vivliostyle CLI の出力ログを逐次収集し、SSE（Server-Sent Events）でフロントエンドへリアルタイム配信する。

## API 一覧
- POST /api/v1/jobs
  - JSON ボディ（base64 エンコード ZIP）でジョブ登録。jobId 未指定時は UUID 生成。
- POST /vivliostyle/jobs
  - 同一オリジン向け multipart/form-data。pageId, pagePath, 	itle, zip を受理し、pageId を正規化して jobId に利用。
- GET /api/v1/jobs/:jobId
  - ジョブステータス・メタデータ・成果物リスト・ログ末尾を返す。
- GET /api/v1/jobs/:jobId/result
  - 成果物をストリーム返却。?file= で output 以下のファイルを指定。
- GET /api/v1/jobs/:jobId/log
  - 既存ログ（NDJSON）をまとめて返す。
- GET /api/v1/jobs/:jobId/log/stream
  - SSE でリアルタイムにログとステータス更新を配信。ジョブ完了時に complete イベントでクローズ。
- DELETE /api/v1/jobs/:jobId
  - 成果物・ログを含むジョブディレクトリを削除。進行中ジョブは 409。

## ジョブライフサイクル
1. リクエスト受信・検証（VIV_MAX_ARCHIVE_SIZE_MB 既定 500 MB を超えたら拒否）。
2. jobs/<jobId> を作成し、入力 ZIP とリクエストスナップショットを保存。
3. ジョブをキューに投入し、SSE で queued を配信。
4. ワーカーがジョブを取得し unning に遷移、展開→Vivliostyle CLI 実行。
5. CLI stdout/stderr を NDJSON に追記しつつ SSE へ中継。
6. 成功時は成果物を output/ に収集し succeeded を配信。失敗時は job.json にエラーを記録し ailed を配信。
7. 完了後は入力 ZIP と workspace を削除（成果物は保持）。ATTACHMENT へ移送後に DELETE API でジョブごと削除。

## 既定設定
- VIV_QUEUE_CONCURRENCY = 2
- VIV_MAX_ARCHIVE_SIZE_MB = 500
- VIV_CLI_TIMEOUT_MS = 600000
- VIV_WORKSPACE_DIR = <repo>/jobs

## 今後の検討事項
- ジョブ完了通知の Webhook 対応。
- API 認証・認可（トークン等）。
- 古い成果物の自動削除ポリシー（cron / TTL）。
- 逆プロキシ（src/proxyServer.ts）越しの TLS 運用。
