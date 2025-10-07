# 利用ガイド

この文書は「セットアップ方法が全く分からない」という方でもサービスを立ち上げられるよう、手順を丁寧に説明します。必要なコマンドはすべてコピーして実行できる形で記載しています。

## 事前準備（初回のみ）
1. **Node.js のインストール**  
   - 推奨バージョン: Node.js 18.18 以上（LTS 版を推奨）。  
   - 公式サイト <https://nodejs.org/ja/> からインストーラを取得し、画面の指示に従ってインストールしてください。
2. **インストール確認**  
   コマンドプロンプトやターミナルで次を実行し、バージョンが表示されれば成功です。
   ```bash
   node -v
   npm -v
   ```
3. **リポジトリの取得**  
   - Git を利用できる場合:  
     ```bash
     git clone https://example.com/your/repo.git
     ```
   - Git を利用しない場合は、ZIP をダウンロードして任意のフォルダに展開してください。

## 初期セットアップ
1. プロジェクトのルートディレクトリに移動します:
   ```bash
   cd GROWI-VivliostyleCLI-Server
   ```
2. 依存関係をインストールします（初回または依存更新後に一度実行）:  
   `package.json` では `@vivliostyle/cli` を常に最新版で取得するよう `latest` タグを指定しています。`npm install` を実行するたび、Vivliostyle は最新リリースに差し替わります。
   ```bash
   npm install
   ```

## 開発・動作確認コマンド
- `npm run dev`  
  開発モードでサーバーを起動します。ソースを保存すると自動的に再起動します。
- `npm run build`  
  TypeScript をコンパイルして `dist/` に成果物を出力します。デプロイ前の確認に使用します。
- `npm start`  
  `npm run build` 実行後の成果物を Node.js で起動します。本番運用で利用する想定です。
- `npm test`  
  Vitest によるテストを実行します。Vivliostyle CLI 実行部分はモック化されているため高速に確認できます。

## 依存関係のアップデート方法
1. どのパッケージが古いか確認:
   ```bash
   npm outdated
   ```
2. 影響の少ない更新を一括反映（互換性のある範囲で更新）:
   ```bash
   npm update
   ```
3. 個別パッケージを最新版に上げる場合:
   ```bash
   npm install <パッケージ名>@latest
   ```
4. 更新後は必ずテストを実行し、動作に問題がないか確認してください:
   ```bash
   npm test
   ```

## アンインストール／クリーンアップ
プロジェクトをまるごと削除したいときは、以下の手順で「インストールされたもの」をリセットできます。

1. 依存パッケージの削除（任意）  
   ```bash
   npm uninstall @vivliostyle/cli express p-queue unzipper uuid zod
   ```
   個別にアンインストールする代わりに `rm -rf node_modules package-lock.json` で依存をまとめて消しても構いません。
2. ビルド成果物とジョブワークスペースの削除  
   ```bash
   npm run clean
   rimraf jobs
   ```
3. プロジェクト自体を消す場合は、フォルダを削除すれば完了です。Git 管理下なら `git clean -fdx` で未追跡ファイルを一掃できます（実行前に変更がないか確認してください）。

## 環境変数（設定項目）
環境変数を使うことで、環境に合わせた動作を簡単に切り替えられます。`.env` を用意して `npm run dev` 前に読み込むか、コマンドの先頭に `VIV_QUEUE_CONCURRENCY=2` のように付与して利用してください。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `4781` | HTTP サーバーの待受ポート。 |
| `VIV_WORKSPACE_DIR` | `<repo>/jobs` | ジョブワークスペースと成果物格納ルート。 |
| `VIV_QUEUE_CONCURRENCY` | `1` | Vivliostyle CLI の同時実行数。 |
| `VIV_MAX_ARCHIVE_SIZE_MB` | `50` | 受け付ける base64 ZIP アーカイブの最大容量（MB）。 |
| `VIV_CLI_TIMEOUT_MS` | `600000` | Vivliostyle CLI のタイムアウト（ミリ秒）。 |

## 本番運用時のポイント
1. `VIV_WORKSPACE_DIR` は十分な容量がある永続ストレージに設定。
2. Vivliostyle CLI が利用するフォントやブラウザ依存ライブラリを事前に整備。
3. `npm run build` → `npm start` の順で起動し、systemd/PM2 などのプロセスマネージャーで常駐化。
4. GROWI 側プラグインの接続先を `https://<host>:PORT/api/v1/jobs` に変更し、成果物を ATTACHMENT へアップロードし終えたら `DELETE /api/v1/jobs/:jobId` を呼んでサーバー上のジョブを削除する運用を徹底。

## トラブルシューティング
- `npm install` でエラーが出た場合は、`node_modules` と `package-lock.json` を削除してから再実行すると解決することがあります。
- Windows で文字化けが発生する場合は、ターミナルの文字コードを UTF-8 に変更してください。
- Vivliostyle CLI の実行でタイムアウトした場合は、`VIV_CLI_TIMEOUT_MS` を引き上げるか、入力プロジェクトのサイズを見直してください。
