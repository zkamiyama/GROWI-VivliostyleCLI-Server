# GROWI ↔ Vivliostyle CLI 連携アーキテクチャ

## 概要
本サービスは Vivliostyle CLI を用いて公開用成果物（標準は PDF）を生成する REST API を公開し、GROWI の Vivliostyle プラグインから呼び出されることを想定する。サーバーの責務は以下のとおり。

- プラグインから届くジョブリクエストの検証と永続化。
- プラグインがアップロードした書籍／プロジェクトの ZIP バンドル展開。
- ジョブごとに分離されたワークスペースでの Vivliostyle CLI 実行。
- ジョブのメタデータ、ログ、ビルド成果物の永続化と再取得。
- HTTP エンドポイントを通じたジョブステータス・ログ・成果物の提供。

永続化はサービスが動作するホストローカルで完結し、外部 DB 等は不要。

## 構成要素
- **HTTP API（Express）** – リクエストの受理／検証、成果物ダウンロード、ジョブ情報公開を担う。
- **Job Store** – `jobs/<jobId>/job.json` にジョブ状態を記録し、タイムスタンプや CLI 終了コード、成果物メタ情報を保持する。
- **Queue & Worker** – メモリ内キュー（PQueue）で同時実行数を制御。ワーカーがアーカイブ展開と CLI 実行を行う。
- **Vivliostyle Runner** – 同梱された CLI エントリーポイントを `node` で起動し、標準出力／標準エラーを構造化ログとして収集するラッパー。

## リクエストライフサイクル
1. **ジョブ登録** (`POST /api/v1/jobs`) – プラグインが Vivliostyle プロジェクトを含む ZIP を base64 で送信。エントリーファイルや config など CLI 用ヒントは任意。
2. **永続化** – サーバーが `jobId` を割り当て／検証し `jobs/<jobId>/request.json` を作成、ZIP を保存、初期メタデータを書き込む。
3. **キュー投入** – ジョブをキューへ追加し、ステータスを `queued` に遷移させる。
4. **実行** – ワーカーがステータスを `running` にし、`jobs/<jobId>/workspace` に展開、CLI 引数を決定し、作業ディレクトリを `cwd` として Vivliostyle CLI を起動。
5. **成果物収集** – 生成ファイルを `jobs/<jobId>/output` にコピーし、ファイル名・サイズ・MIME 情報をメタデータに反映。
6. **完了処理** – ステータスを `succeeded` もしくは `failed` に更新し、CLI ログを `jobs/<jobId>/log.ndjson` へ追記。
7. **クライアントポーリング** – プラグインが `/api/v1/jobs/:jobId` をポーリングし、準備完了後に `/api/v1/jobs/:jobId/result` から成果物を取得。

## API
- `POST /api/v1/jobs`
  - リクエスト例:  
    ```json
    {
      "jobId": "任意ID",
      "sourceArchive": "base64-zip-string",
      "cliOptions": {
        "configPath": "workspace 相対パス",
        "entry": ["任意の入力ファイル"],
        "outputFile": "optional/output.pdf",
        "format": "pdf|webpub|zip"
      },
      "metadata": {
        "title": "任意タイトル",
        "requestedBy": "リクエストしたユーザー識別子"
      }
    }
    ```
  - レスポンス: `{ "jobId": "...", "status": "queued", "createdAt": "ISO8601" }`
  - 代表的エラー:
    - `400`: ペイロード不正またはアーカイブ容量オーバー。
    - `409`: 任意指定した `jobId` が既存ジョブと衝突。
- `GET /api/v1/jobs/:jobId`
  - ジョブメタ情報、タイムスタンプ、CLI 終了コード、成果物一覧、ログ末尾（最新 50 行）を返す。
- `GET /api/v1/jobs/:jobId/result`
  - 主要成果物（`outputFile` または最初の PDF）を `Content-Disposition: attachment` 付きでストリーム返却。
  - `?file=relative/path` で出力ディレクトリ内の任意ファイルを取得。
- `GET /api/v1/jobs/:jobId/log`
  - 構造化ログをテキストストリームで返し、リアルタイムビューに利用可能。
- `DELETE /api/v1/jobs/:jobId`
  - プラグインからの削除シグナルを受け、ジョブディレクトリ（成果物・ログ含む）を完全削除する。`running` / `queued` / `created` の状態では `409` を返し、完了後のみ削除が可能。

## ジョブデータ構造
```
jobs/
  {jobId}/
    request.json     # アーカイブを除いた元リクエスト
    job.json         # 現在のステータスとメタデータ
    source.zip       # アップロードされた ZIP
    workspace/       # CLI の作業ディレクトリ (cwd)
    output/          # 完了後にコピーされる成果物一式
    log.ndjson       # timestamp, level, message を持つ構造化ログ
```

## エラーハンドリングと復旧
- キュー処理で失敗した場合はステータスを `failed` にし、エラー内容（`message`, `stack`）を保存。
- CLI が非ゼロ終了してもワーカーが Job Store を更新し、標準出力／標準エラーをログに残す。
- サーバー再起動時は既存 `job.json` を読み込み、停止時に `running` だったジョブは `server-restart` 理由付きで `failed` に更新。

## 設定項目
環境変数（括弧内は既定値）:
- `PORT` (`4781`)
- `VIV_QUEUE_CONCURRENCY` (`1`)
- `VIV_WORKSPACE_DIR` (`<repo>/jobs`)
- `VIV_MAX_ARCHIVE_SIZE_MB` (`50`)
- `VIV_CLI_TIMEOUT_MS` (`600000` = 10 分)

## GROWI プラグイン連携メモ
- プラグイン側は `vivliostyle.config.js` やエントリーファイルを含むプロジェクトを ZIP 化し、base64 化して送信する必要がある。
- ジョブの完了監視（`status === "succeeded"`）と成果物ダウンロードはプラグインの責務。
- 成果物を GROWI の ATTACHMENT ストレージへ移動し終えたら、`DELETE /api/v1/jobs/:jobId` を必ず呼び出し、サーバー上のジョブデータを削除する。（削除しない場合は成果物が残り続ける。）
- `entry` を指定する場合はアップロードしたアーカイブ内に存在するワークスペース相対パスを使用すること。
- WebPub や ZIP など別形式を出力する場合は `cliOptions.format` を設定し、ダウンロード時の MIME に留意する。
- 監査情報として `metadata.requestedBy` に GROWI ユーザー識別子を入れることを推奨。
- 将来的に Webhook を実装する際には `callbackUrl` を受け付ける予定だが、現時点では未対応。
