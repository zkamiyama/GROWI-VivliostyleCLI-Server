# 利用ガイド

このドキュメントは初めてセットアップする人でも迷わないよう、手順を丁寧にまとめています。必要なコマンドはそのままコピーして実行できます。

## 1. 事前準備
1. **Node.js をインストール**（推奨: v18.18 以上の LTS）
   - 公式サイト <https://nodejs.org/ja/> からインストーラを取得し、画面の指示に従ってインストールします。
2. **インストール確認**
   `ash
   node -v
   npm -v
   `
   バージョン番号が表示されれば準備完了です。
3. **ソースコード取得**
   - Git を利用する場合
     `ash
     git clone https://example.com/your/repo.git
     `
   - Git を使わない場合は ZIP をダウンロードして任意の場所に展開します。

## 2. セットアップ
1. プロジェクトディレクトリへ移動:
   `ash
   cd GROWI-VivliostyleCLI-Server
   `
2. 依存パッケージをインストール（初回／更新のたびに実行）:
   `ash
   npm install
   `
   package.json では @vivliostyle/cli を latest 指定しているため、
pm install のたびに最新リリースへ更新されます。

## 3. よく使うコマンド
- 
pm run dev : 	sx を利用したホットリロードサーバー
- 
pm run build : TypeScript をコンパイルし dist/ に出力
- 
pm start : ビルド成果物を起動（本番用）
- 
pm test : Vitest によるテスト実行
- 
pm run proxy : 逆プロキシを 	sx で起動（開発向け）
- 
pm run proxy:start : ビルド済み dist/proxyServer.js を起動

## 4. 依存パッケージの更新
1. どのパッケージが古いか確認
   `ash
   npm outdated
   `
2. 互換性のある範囲でまとめて更新
   `ash
   npm update
   `
3. 特定パッケージだけ最新版にする
   `ash
   npm install <package>@latest
   `
4. 更新後は必ずテスト
   `ash
   npm test
   `

## 5. アンインストール／クリーンアップ
- 依存パッケージをまとめて削除
  `ash
  rm -rf node_modules package-lock.json
  `
- ビルド成果物とジョブデータを削除
  `ash
  npm run clean
  rimraf jobs
  `
- プロジェクトごと削除する場合はフォルダを削除、もしくは Git 管理下で git clean -fdx

## 6. 環境変数（既定値）
| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| PORT | 4781 | API サーバーの待受ポート |
| VIV_WORKSPACE_DIR | <repo>/jobs | ジョブデータ格納パス |
| VIV_QUEUE_CONCURRENCY | 2 | 同時に実行する Vivliostyle ジョブ数 |
| VIV_MAX_ARCHIVE_SIZE_MB | 500 | 受け付ける ZIP の最大サイズ |
| VIV_CLI_TIMEOUT_MS | 600000 | Vivliostyle CLI のタイムアウト（ミリ秒） |
| VIV_PROXY_TARGET | http://127.0.0.1:4781 | プロキシ転送先 |
| VIV_PROXY_PORT | 4871 | プロキシ待受ポート |

.env を用意して 
pm run dev の前に読み込む、もしくはコマンドの前に VIV_QUEUE_CONCURRENCY=4 npm start のように指定してください。

## 7. API 利用例
### JSON API（base64 で ZIP を送信）
`ash
curl -X POST http://localhost:4781/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "sourceArchive": "BASE64_ZIP",
    "metadata": { "title": "My Book" }
  }'
`
Base64 は元 ZIP より約 1.33 倍になるため、500 MB の制限内に収まるよう圧縮や画像最適化を行ってください。

### 同一オリジン向け multipart API
`ash
curl -X POST http://localhost:4781/vivliostyle/jobs \
  -F pageId=page:123 \
  -F pagePath=/book/sample \
  -F title="サンプル書籍" \
  -F zip=@./project.zip
`
pageId は jobId に正規化されます（英数字・._- 以外は - に置換）。空になる場合は UUID が割り当てられます。

### SSE でログ／ステータスを受信
`ash
curl -N http://localhost:4781/api/v1/jobs/<jobId>/log/stream
`
- data: 行にログ（JSON）が流れます。
- vent: status で queued / unning / succeeded / ailed を受信。
- ジョブ完了時に vent: complete が届き接続がクローズされます。

### 成果物のダウンロード
`ash
curl -L http://localhost:4781/api/v1/jobs/<jobId>/result -o output.pdf
`
任意ファイルを取得したい場合は ?file=relative/path を付与します。

### 処理後のクリーンアップ
`ash
curl -X DELETE http://localhost:4781/api/v1/jobs/<jobId>
`
ATTACHMENT へ成果物を移した後に必ず実行し、サーバー上の一時ファイルを削除してください。

## 8. 逆プロキシの利用
src/proxyServer.ts は http-proxy を使った簡易リバースプロキシです。
`ash
npm run proxy        # tsx を使った開発起動
npm run proxy:start  # dist/proxyServer.js を実行
`
環境変数 VIV_PROXY_TARGET で転送先 API、VIV_PROXY_PORT で待受ポートを指定します。TLS 終端を前段に置きたい場合は、このプロキシを HTTPS の背後に配置してください。

## 9. トラブルシューティング
- 
pm install に失敗する: m -rf node_modules package-lock.json でキャッシュを削除し再実行。
- Windows で文字化けする: ターミナルの文字コードを UTF-8 に変更。
- Vivliostyle CLI がタイムアウトする: VIV_CLI_TIMEOUT_MS を引き上げるか、入力のサイズ・複雑さを見直す。
- SSE が届かない: ブラウザが HTTP/1.1 でアクセスしているかを確認し、リバースプロキシのバッファリング（X-Accel-Buffering: no 等）を無効化する。

