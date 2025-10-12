# 利用ガイド

このドキュメントは初めてセットアップする人でも迷わないよう、手順を丁寧にまとめています。必要なコマンドはそのままコピーして実行できます。

## 1. 事前準備
1. **Node.js をインストール**（推奨: v18.18 以上の LTS）
   - 公式サイト <https://nodejs.org/ja/> からインストーラを取得し、画面の指示に従ってインストールします。
2. **インストール確認**
   `bash
   node -v
   npm -v
   `
   バージョン番号が表示されれば準備完了です。
3. **ソースコード取得**
   - Git を利用する場合
     `bash
     git clone https://example.com/your/repo.git
     `
   - Git を使わない場合は ZIP をダウンロードして任意の場所に展開します。

## 2. セットアップ
1. プロジェクトディレクトリへ移動:
   `bash
   cd GROWI-VivliostyleCLI-Server
   `
2. 依存パッケージをインストール（初回／更新のたびに実行）:
   `bash
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
   `bash
   npm outdated
   `
2. 互換性のある範囲でまとめて更新
   `bash
   npm update
   `
3. 特定パッケージだけ最新版にする
   `bash
   npm install <package>@latest
   `
4. 更新後は必ずテスト
   `bash
   npm test
   `

## 5. アンインストール／クリーンアップ
- 依存パッケージをまとめて削除
  `bash
  rm -rf node_modules package-lock.json
  `
- ビルド成果物とジョブデータを削除
  `bash
  npm run clean
  rimraf jobs
  `
- プロジェクトごと削除する場合はフォルダを削除、もしくは Git 管理下で git clean -fdx

## 6. 環境変数（既定値）
| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| PORT | 4781 | API サーバーの待受ポート |
| VIV_WORKSPACE_DIR | <repo>/jobs | ジョブデータ保管パス |
| VIV_QUEUE_CONCURRENCY | 2 | 同時に実行する Vivliostyle ジョブ数 |
| VIV_MAX_ARCHIVE_SIZE_MB | 500 | 受け付ける ZIP の最大サイズ |
| VIV_CLI_TIMEOUT_MS | 600000 | Vivliostyle CLI のタイムアウト（ms） |
| VIV_AUTOCLEANUP_TIMEOUT_MS | 900000 | DELETE が来ない場合に自動削除へ移行するまでの待機時間（ms、0 で無効化） |
| VIV_FRONTEND_PING_URL | （空） | 自動削除前に HEAD するフロントエンドの疎通確認 URL |
| VIV_FRONTEND_PING_TIMEOUT_MS | 3000 | フロント疎通確認のタイムアウト（ms） |
| VIV_PROXY_TARGET | http://127.0.0.1:4781 | リバースプロキシ配下での API 宛先 |
| VIV_PROXY_PORT | 4871 | リバースプロキシの待受ポート |

.env を用意して 
pm run dev の前に読み込む、もしくはコマンドの前に VIV_QUEUE_CONCURRENCY=4 npm start のように指定してください。

## 7. API 利用例
### JSON API（base64 で ZIP を送信）
`bash
curl -X POST http://localhost:4781/vivliostyle/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "sourceArchive": "BASE64_ZIP",
    "metadata": { "title": "My Book" }
  }'
`
Base64 は元 ZIP より約 1.33 倍になるため、500 MB の制限内に収まるよう圧縮や画像最適化を行ってください。

### 同一オリジン向け multipart API
`bash
curl -X POST http://localhost:4781/vivliostyle/jobs \
  -F pageId=page:123 \
  -F pagePath=/book/sample \
  -F title="サンプル書籍" \
  -F zip=@./project.zip
`
pageId は jobId に正規化されます（英数字・._- 以外は - に置換）。空になる場合は UUID が割り当てられます。

### SSE でログ／ステータスを受信
`bash
curl -N http://localhost:4781/vivliostyle/jobs/<jobId>/log/stream
`
- data: 行にログ（JSON）が流れます。
- event: status で queued / 
unning / succeeded / failed を受信。
- ジョブ完了時に event: complete が届き接続がクローズされます。

### 成果物のダウンロード
`bash
curl -L http://localhost:4781/vivliostyle/jobs/<jobId>/result -o output.pdf
`
任意ファイルを取得したい場合は ?file=relative/path を付与します。

### 処理後のクリーンアップ
`bash
curl -X DELETE http://localhost:4781/vivliostyle/jobs/<jobId>
`
ATTACHMENT へ成果物を移した後に必ず実行し、サーバー上の一時ファイルを削除してください（タイムアウト後には自動削除されるものの、明示的なクリーンアップ推奨）。

## 8. 逆プロキシの利用
src/proxyServer.ts は http-proxy を使った簡易リバースプロキシです。
`bash
npm run proxy        # tsx を使った開発起動
npm run proxy:start  # dist/proxyServer.js を実行
`
環境変数 VIV_PROXY_TARGET で転送先 API、VIV_PROXY_PORT で待受ポートを指定します。TLS 終端を前段に置きたい場合は、このプロキシを HTTPS の背後に配置してください。

### プロキシ挙動の詳細（重要）

このリポジトリに同梱の簡易プロキシはルーティングルールを持ち、以下のように振り分けます。

- `/vivliostyle/*` → Vivliostyle CLI サーバ（デフォルト `VIV_PROXY_TARGET=http://127.0.0.1:4781`）へ転送
- それ以外（`/` を含む）→ GROWI（デフォルト `GROWI_TARGET=http://127.0.0.1:3000`）へ転送

このため、Funnel 等を使って公開した場合でも `https://<funnel-domain>/` にアクセスすると GROWI のトップページが表示され、`https://<funnel-domain>/vivliostyle/jobs` に対しては Vivliostyle API が応答します。

プロキシの挙動を変更したい場合は `src/proxyServer.ts` を編集するか、環境変数 `VIV_PROXY_TARGET` / `GROWI_TARGET` を設定してください。

## 9. トラブルシューティング
- 
pm install に失敗する: 
m -rf node_modules package-lock.json でキャッシュを削除し再実行。
- Windows で文字化けする: ターミナルの文字コードを UTF-8 に変更。
- Vivliostyle CLI がタイムアウトする: VIV_CLI_TIMEOUT_MS を引き上げるか、入力のサイズ・複雑さを見直す。
- SSE が届かない: ブラウザが HTTP/1.1 でアクセスしているかを確認し、リバースプロキシのバッファリング（X-Accel-Buffering: no 等）を無効化する。


## 10. リバースプロキシ + Docker クイックスタート
1. **前提** – Docker / Docker Compose と Node.js (18 以上) をインストールし、このリポジトリをクローンします。
2. **GROWI コンテナを用意** – 公式ドキュメントの最小構成をベースに `docker-compose.yml` を作成します。以下は MongoDB / Redis / Elasticsearch を含む例です。
   ```yaml
   version: "3.8"
   services:
     mongo:
       image: mongo:6
       volumes:
         - mongo-data:/data/db
     redis:
       image: redis:6
     elasticsearch:
       image: docker.elastic.co/elasticsearch/elasticsearch:7.17.9
       environment:
         - discovery.type=single-node
         - ES_JAVA_OPTS=-Xms512m -Xmx512m
     growi:
       image: weseek/growi:5
       ports:
         - "3000:3000"
       environment:
         - MONGO_URI=mongodb://mongo:27017/growi
         - REDIS_URI=redis://redis:6379
         - ELASTICSEARCH_URI=http://elasticsearch:9200/growi
       depends_on:
         - mongo
         - redis
         - elasticsearch
   volumes:
     mongo-data:
   ```
   `docker compose up -d` で GROWI を起動すると `http://localhost:3000/` でアクセスできます。
3. **Vivliostyle CLI サーバーを起動** – このリポジトリで依存関係を取得し、ビルド後にサーバーを立ち上げます。
   ```bash
   npm install
   npm run build
   node dist/index.js
   ```
   `.env` を使う場合は、同一オリジンで利用しやすいよう `PORT=4781` や `VIV_AUTOCLEANUP_TIMEOUT_MS=600000` などを設定します。
4. **薄いリバースプロキシを起動** – `npm run proxy` で `src/proxyServer.ts` を立ち上げると、`http://localhost:4871/` が GROWI（`/`）と Vivliostyle サーバー（`/vivliostyle` 以下）を同一オリジンに束ねます。
5. **動作確認** – ブラウザで `http://localhost:4871/` にアクセスし、GROWI にログインした状態でプラグインから `/vivliostyle/jobs` を叩けることを確認します。ジョブ完了後、一定時間 DELETE が飛ばなくても自動削除され、SSE のログは `[jobs]` プレフィックス付きで届く点もチェックしてください。
6. **停止** – `Ctrl+C` でプロキシと Vivliostyle サーバーを停止し、`docker compose down` で GROWI 側のコンテナを終了します。

## 11. PM2 で常駐運用する

### クローン直後の最短手順

```bash
npm ci --omit=dev
npm run pm2:setup
```

`npm run pm2:setup` は内部で本番ビルドを実行し、`pm2.config.cjs` を使って PM2 に `vivliostyle-cli-server` と `vivliostyle-proxy` を登録、`pm2 save` まで自動で行います。ログと状態もその場で表示されるので、コマンド 2 行で常駐化できます。

### 仕組みとファイル

- `pm2.config.cjs`: PM2 に登録するアプリ定義です（リポジトリ直下）。`dist/index.js` と `dist/proxyServer.js` の 2 プロセスを同一ルートで管理し、必要な環境変数を既定値付きで設定しています。
- `scripts/pm2/setup.mjs`: `npm run pm2:setup` が呼び出すセットアップスクリプトです。`--skip-build` でビルドを省略、`--server-only` / `--proxy-only` で個別起動、といったオプションにも対応しています。
- `package.json` の `pm2:setup` スクリプトは Node 18 以降で動作します。Windows でも `npm.cmd` / `npx.cmd` を自動で呼び分けます。

### OS 起動時の復元設定

一度プロセスを登録したら、以下を実行して PM2 の自動起動を設定してください。OS ごとの案内が表示されるので、指示されたコマンドを管理者権限で実行します。

```bash
npx pm2 startup
```

その後で `npx pm2 save` を繰り返し実行すると、最新のプロセス一覧が保存されます（`npm run pm2:setup` が自動で実行するため通常は不要です）。

### 運用時によく使うコマンド

- 状態確認: `npx pm2 status`
- ログ監視: `npx pm2 logs vivliostyle-cli-server`（プロキシは `vivliostyle-proxy`）
- 設定変更やアップデート反映: `git pull` → `npm ci --omit=dev` → `npm run pm2:setup -- --skip-build`
- アプリだけ再起動: `npx pm2 reload vivliostyle-cli-server`（プロキシも再起動する場合は `pm2 reload pm2.config.cjs`）
- 停止 / 削除: `npx pm2 stop vivliostyle-cli-server`、完全削除は `npx pm2 delete vivliostyle-cli-server`

`pm2.config.cjs` を直接編集して環境変数を変更できます。変更後は `npm run pm2:setup -- --skip-build` で再適用するか、`npx pm2 reload pm2.config.cjs` を使って反映してください。

## ブラウザだけでの最小確認（Console）

実装に合わせた最小確認手順を示します。可能であればプロキシ（例: `http://localhost:4871/`）で GROWI の画面を開き、その同一オリジンの Console から以下を実行してください。プロキシを使うと CORS を気にせず確認できます。API サーバー直叩き（`http://localhost:4781`）でも動作しますが、ブラウザ側で CORS に注意してください。

1) サーバが生きているか（簡易チェック）

- ブラウザのアドレスバーで次を開く:
  - `http://localhost:4781/healthz` → JSON が返れば API サーバーが起動しています。
  - プロキシを使う場合は `http://localhost:4871/` を開いて GROWI の画面が表示されるか確認します。

2) ジョブ登録（最小：Console で multipart を送る）

- ブラウザの開発者ツール Console に貼って実行します。サーバは multipart のファイルフィールド名 `zip` を受け取ります。

```javascript
(async () => {
  const form = new FormData();
  form.append('pageId', 'page:browser-test');
  form.append('pagePath', '/browser/test');
  form.append('title', 'ブラウザテスト');

  // 最小の ZIP ヘッダを含む Blob（ジョブ登録確認用）。本番では実際の ZIP をアップロードしてください。
  const zipHeader = 'PK\x03\x04';
  const blob = new Blob([zipHeader], { type: 'application/zip' });
  form.append('zip', blob, 'bundle.zip');

  const res = await fetch('/vivliostyle/jobs', { method: 'POST', body: form });
  const txt = await res.text();
  try {
    console.log('response', JSON.parse(txt));
  } catch (e) {
    console.log('response text', txt);
  }
})();
```

- 返却は通常 `202` で `{ jobId, status: 'queued', createdAt }` 形式です。`jobId` を控えてください。

3) ジョブの状態確認（ポーリング）

```javascript
// jobId を上の結果で置き換えて実行
(async () => {
  const jobId = 'PUT_JOB_ID_HERE';
  const r = await fetch(`/vivliostyle/jobs/${jobId}`);
  console.log(await r.json());
})();
```

4) SSE（ログ／ステータス）を受信する（リアルタイム）

- サーバ実装では SSE エンドポイントが `/vivliostyle/jobs/:jobId/log/stream` にあります。以下は Console スニペットです。

```javascript
// jobId を上の結果で置き換え
const jobId = 'PUT_JOB_ID_HERE';
const es = new EventSource(`/vivliostyle/jobs/${jobId}/log/stream`);
es.addEventListener('jobs', (ev) => {
  try { console.log('log', JSON.parse(ev.data)); } catch { console.log('log raw', ev.data); }
});
es.addEventListener('status', (ev) => console.log('status', JSON.parse(ev.data)));
es.addEventListener('complete', (ev) => { console.log('complete', JSON.parse(ev.data)); es.close(); });
es.onerror = (err) => console.warn('SSE error', err);
```

- SSE で過去ログ（NDJSON の各行が `event: jobs` として送られる）、`status`（queued/running/succeeded/failed）、ジョブ完了時の `complete` を受け取れます。

5) 成果物確認（成功時）

- 成功すると `/vivliostyle/jobs/:jobId/result` からダウンロードできます（ブラウザで次を開く）：

```
/vivliostyle/jobs/<jobId>/result
```

- またはクライアント側で `window.open(`/vivliostyle/jobs/${jobId}/result`)` を実行してダウンロードを開始できます。

注意点
- 事前にサーバと（必要なら）プロキシが起動していることを確認してください。
- 実際に PDF を作るためには有効な ZIP（doc.html と関連アセット）が必要です。ここでは「登録→SSEでログを見る」までが最小確認です。
- もし SSE が届かない場合は中間プロキシのバッファリングやロードバランサのタイムアウト（ALB/Cloudflare など）を疑ってください。

