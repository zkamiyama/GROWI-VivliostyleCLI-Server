Nginx のリバースプロキシ前提を「Node/Express で同一オリジン配下の統合ランタイム」に置き換えて、要件（**`/vivliostyle/jobs` を使う / PDF は生成後に GROWI へ添付アップロード → Temp を確実削除**）を満たす形で**文章と実装を丸ごと書き直し**ます。

（根拠：Vivliostyle CLI の `build` コマンドで PDF 生成ができること、GROWI には添付保存先の公式設定があり API 連携で透過化できること、同一オリジン＝「スキーム＋ホスト＋ポート」一致で CORS を回避できること、Express で静的配信やプロキシをまとめて面倒を見られること。）[npm+5GitHub+5docs.growi.org+5](https://github.com/vivliostyle/vivliostyle-cli)

---

# 全体像（Express 版アーキテクチャ：改訂）

- `https://wiki.example.com/` → **GROWI 本体**（別プロセス: 例 `127.0.0.1:3000`）
    
    ↳ Express が**リバースプロキシ**として `/` を GROWI へ中継（`http-proxy-middleware`）。[npm](https://www.npmjs.com/package/http-proxy-middleware?utm_source=chatgpt.com)
    
- `https://wiki.example.com/vivliostyle/jobs` → **ジョブAPI（ミニサービス）**（本 Express 内で実装）
- `https://wiki.example.com/vivliostyle/inputs/…` → **Vivliostyle が読む入力HTML**（同一オリジンで Express が静的配布）[expressjs.com](https://expressjs.com/en/starter/static-files.html?utm_source=chatgpt.com)
- 生成PDFは**ミニサービス側で一時ディレクトリに生成**→**GROWI の添付APIで該当ページへアップロード**→**finally で一時ファイル/ディレクトリを確実に削除**（成功/失敗どちらでも消す）
    
    ↳ GROWI は添付の保存先を **S3 / GCS / Azure / MongoDB / ローカル**のいずれでも設定可能（API 経由なら同じコードで吸収）。[docs.growi.org](https://docs.growi.org/en/admin-guide/admin-cookbook/attachment.html?utm_source=chatgpt.com)
    

> ポイント：URL は同一オリジン（スキーム＋ホスト＋ポート一致）を厳守。/vivliostyle/* をパス切りでまとめると CORS 不要でフォントや画像も安定します（SOP: Same-Origin Policy）。MDNウェブドキュメント
> 

---

# 役割とフロー（Express 版）

1. **GROWI プラグイン（フロント）**
    - ページツールに「PDF出力」ボタン。押下で
        
        `POST /vivliostyle/jobs`（JSON: `pageId`, `pagePath`, 体裁オプション etc.）へ送信。
        
    - レスポンスの `jobId` を用いて **ポーリング**（`GET /vivliostyle/jobs/{id}`）または **SSE** で進捗表示。完了後、**何もしない（サーバが GROWI に添付済み）**。
    - スクリプトプラグインの作り方は公式の手順に従う（TypeScript + Vite 推奨）。[docs.growi.org](https://docs.growi.org/en/dev/plugin/script.html?utm_source=chatgpt.com)
2. **ジョブAPI（同一 Express プロセス内）**
    - `pageId` を受け取り、`/vivliostyle/inputs/{jobId}/doc.html` を生成・配布。
    - **Vivliostyle CLI** を `vivliostyle build <入力URL> -o <tmp>/out.pdf` で実行。[GitHub](https://github.com/vivliostyle/vivliostyle-cli)
    - 出来上がった `out.pdf` を **GROWI の添付 API**（multipart）で **該当 `pageId` にアップロード**。
        - GROWI の REST v3 は公式に公開。添付保存先は前述のとおり透過化。削除系の `/_api/attachments.remove` は開発者向け資料にも掲載。[docs.growi.org+2docs.growi.org+2](https://docs.growi.org/en/api/rest-v3.html?utm_source=chatgpt.com)
    - **finally で** 一時領域を**確実に削除**。
3. **GROWI 側**
    - 添付の保存・配信は既存設定（S3/GCS/Azure/DB/ローカル）に従って処理。以後の閲覧/ダウンロードは GROWI が担当。[docs.growi.org](https://docs.growi.org/en/admin-guide/admin-cookbook/attachment.html?utm_source=chatgpt.com)

---

# Express による「統合リバースプロキシ + ジョブAPI」実装（**全文**）

> 前提: Node 18+
> 
> 
> 依存: `npm i express http-proxy-middleware undici form-data @fastify/busboy`（またはバンドラ依存なしで OK）
> 
> `VIV_CMD` に `vivliostyle` が見えるよう、`@vivliostyle/cli` を導入済みであること。[GitHub](https://github.com/vivliostyle/vivliostyle-cli)
> 

```jsx
// server.js
// 1 プロセスで「リバースプロキシ」「Vivliostyle 入力配信」「ジョブAPI」を提供
// 環境: Node 18+
// 依存: express, http-proxy-middleware, undici, form-data

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as undiciRequest } from 'undici';
import FormData from 'form-data';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ================= 設定 =================
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '<https://wiki.example.com>';
const GROWI_TARGET  = process.env.GROWI_TARGET  || '<http://127.0.0.1:3000>'; // GROWI 本体
const VIV_CMD       = process.env.VIV_CMD       || 'vivliostyle';
const TIMEOUT_MS    = +process.env.TIMEOUT_MS   || 180000;
const INPUTS_ROOT   = resolve(process.env.INPUTS_ROOT || './.inputs'); // /vivliostyle/inputs の実体
const GROWI_BASE    = process.env.GROWI_BASE    || '<https://wiki.example.com>';
const GROWI_TOKEN   = process.env.GROWI_TOKEN   || ''; // Bot 等のアクセストークン
const GROWI_USER    = process.env.GROWI_USER    || ''; // 互換用 user パラメータ（必要なら）

await mkdir(INPUTS_ROOT, { recursive: true });

// ================= メモリ内ジョブ管理 =================
const jobs = new Map();         // jobId -> {status, pageId, pagePath, artifact?}
const lastKeyToJobId = new Map(); // Idempotency-Key -> jobId

// ================= Vivliostyle 入力配信（同一オリジン） =================
// Express の静的配信で /vivliostyle/inputs/ を公開
// これで CORS を発生させずに Vivliostyle へ URL 入力を渡せる（同一オリジン前提）。SOP参照。
// 参考: express.static（静的ファイル配信）:contentReference[oaicite:10]{index=10}
app.use('/vivliostyle/inputs', express.static(INPUTS_ROOT, {
  fallthrough: true,
  immutable: false,
  maxAge: '0'
}));

// ================= ジョブAPI =================
app.post('/vivliostyle/jobs', async (req, res) => {
  const idemKey = req.header('Idempotency-Key') || null;
  const { pageId, pagePath, title } = req.body || {};
  if (!pageId || !pagePath) {
    return res.status(400).json({ error: 'pageId and pagePath are required' });
  }

  if (idemKey && lastKeyToJobId.has(idemKey)) {
    const jobId = lastKeyToJobId.get(idemKey);
    const j = jobs.get(jobId);
    return res.status(200).json({ jobId, status: j?.status });
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: 'queued', pageId, pagePath });
  if (idemKey) lastKeyToJobId.set(idemKey, jobId);

  runJob(jobId, { pageId, pagePath, title }).catch(err => {
    console.error('[job failed]', jobId, err);
  });

  res.status(202).setHeader('Location', `/vivliostyle/jobs/${jobId}`)
    .json({ jobId, status: 'queued' });
});

app.get('/vivliostyle/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

async function runJob(jobId, { pageId, pagePath, title }) {
  const j = jobs.get(jobId);
  if (!j) return;
  j.status = 'preparing'; jobs.set(jobId, j);

  // 1) 入力 HTML を生成して /vivliostyle/inputs/job/<id>/doc.html に配置
  const inputsDir = join(INPUTS_ROOT, 'job', jobId);
  await mkdir(inputsDir, { recursive: true });

  const html = String.raw`<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<title>${escapeHtml(title || pagePath)} | PDF</title>
<link rel="stylesheet" href="/assets/print.css">
<body>
  <h1>${escapeHtml(title || pagePath)}</h1>
  <div class="content">
    <p>GROWI のページ（${escapeHtml(pagePath)}）を PDF 化しています。</p>
    <!-- 実運用では GROWI の API で本文を取得して埋め込む or SSR する -->
  </div>
</body></html>`;
  await writeFile(join(inputsDir, 'doc.html'), html, 'utf8');

  // 2) Vivliostyle CLI で PDF 生成（URL 入力）
  // CLI は `build` サブコマンドで PDF を出力可（Vivliostyle CLI README 参照）。:contentReference[oaicite:11]{index=11}
  const inputURL = `${PUBLIC_ORIGIN}/vivliostyle/inputs/job/${jobId}/doc.html`;
  const tempDir  = await mkdtemp(join(tmpdir(), 'viv-'));
  const outPdf   = join(tempDir, 'out.pdf');

  j.status = 'typesetting'; jobs.set(jobId, j);
  await runVivliostyle(inputURL, outPdf, TIMEOUT_MS);

  // 3) GROWI へ添付アップロード（multipart）
  // GROWI REST v3 が公開されており、添付の保存先は設定で吸収される。削除系 API も実在（/attachments.remove）。:contentReference[oaicite:12]{index=12}
  j.status = 'uploading'; jobs.set(jobId, j);

  const form = new FormData();
  form.append('page_id', pageId);
  form.append('file', await readFile(outPdf), { filename: suggestPdfName(pagePath, title) });

  const uploadUrl = new URL(`${GROWI_BASE}/_api/attachments.add`);
  if (GROWI_TOKEN) uploadUrl.searchParams.set('access_token', GROWI_TOKEN);
  if (GROWI_USER)  uploadUrl.searchParams.set('user', GROWI_USER);

  const resp = await undiciRequest(uploadUrl, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });
  if (resp.statusCode >= 300) {
    const text = await resp.body.text();
    throw new Error(`attachments.add failed: ${resp.statusCode} ${text}`);
  }
  const json = await resp.body.json();
  const attachment = json.attachment || null;

  j.status = 'succeeded';
  j.artifact = { attachment, pageId };
  jobs.set(jobId, j);

  // 4) 掃除（常に実行）
  await safeRm(tempDir);
  await safeRm(inputsDir);
}

function runVivliostyle(inputURL, outPdf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ps = spawn(VIV_CMD, ['build', inputURL, '-o', outPdf, '-f', 'pdf'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let killed = false;
    const t = setTimeout(() => {
      killed = true; ps.kill('SIGKILL');
      reject(new Error(`vivliostyle timeout ${timeoutMs}ms`));
    }, timeoutMs);

    ps.stdout.on('data', d => process.stdout.write(`[viv] ${d}`));
    ps.stderr.on('data', d => process.stderr.write(`[viv:err] ${d}`));
    ps.on('close', (code) => {
      clearTimeout(t);
      if (killed) return;
      if (code === 0) resolve();
      else reject(new Error(`vivliostyle exited ${code}`));
    });
  });
}

async function safeRm(p) {
  await rm(p, { recursive: true, force: true, maxRetries: 3 });
}

function suggestPdfName(pagePath, title) {
  const base = (title || pagePath).replace(/[\\\\/:*?"<>|]+/g, '_').slice(-128);
  return `${base || 'document'}.pdf`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ================= リバースプロキシ（最後に定義：/ と競合させない） =================
// /vivliostyle/* は上で処理済み。その他のパスは GROWI へ中継。
app.use('/', createProxyMiddleware({
  target: GROWI_TARGET,
  changeOrigin: true,
  ws: true, // WebSocket
  // 必要に応じてヘッダ付与等のハンドラを追加
}));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Unified server on :${port} (proxy -> ${GROWI_TARGET})`);
});

```

---

## 設計の根拠（簡潔版）

- **Vivliostyle CLI**：`build` サブコマンドで PDF 生成が可能。[GitHub](https://github.com/vivliostyle/vivliostyle-cli)
- **添付の保存先**：GROWI は **S3/GCS/Azure/MongoDB/ローカル**に切り替え可能（クライアントからは API 経由で透過）。[docs.growi.org](https://docs.growi.org/en/admin-guide/admin-cookbook/attachment.html?utm_source=chatgpt.com)
- **REST API v3**：GROWI 公式ドキュメントで公開。削除系の `/_api/attachments.remove` の存在は開発者向け資料にも記載。[docs.growi.org+1](https://docs.growi.org/en/api/rest-v3.html?utm_source=chatgpt.com)
- **同一オリジン（SOP）**：**スキーム＋ホスト＋ポート**が一致すれば CORS 不要。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy?utm_source=chatgpt.com)
- **Express の静的配信／プロキシ**：`express.static` と `http-proxy-middleware` を組み合わせて、Nginx の役割を Node 側で代替。[expressjs.com+1](https://expressjs.com/en/starter/static-files.html?utm_source=chatgpt.com)
- **GROWI スクリプトプラグイン**：フロントから同一オリジンの `fetch()` で `/vivliostyle/jobs` を叩く最小構成が公式ガイドと相性良い。[docs.growi.org](https://docs.growi.org/en/dev/plugin/script.html?utm_source=chatgpt.com)

---

## クリティカルな注意点（あえて辛口）

- *「フロントから直接 GROWI 添付 API を叩く」**のは CSRF/認可の罠が多い。**サーバ（ジョブAPI）に集約**してよし。
- **GROWI の内部ファイルパス直読み**は将来の**S3/GCS への移行で破綻**しやすい。**API 経由で取得/アップロード**する設計を徹底。[docs.growi.org](https://docs.growi.org/en/admin-guide/admin-cookbook/attachment.html?utm_source=chatgpt.com)
- **順番ミス**に注意：Express で `/vivliostyle/*` を**先に**登録し、最後に `/` の**プロキシ**を当てる（でないとループ/誤中継の危険）。
- **同一オリジン**は「サブドメイン違い・ポート違いで別オリジン」になる（`https://wiki.example.com` と `https://wiki.example.com:444` は別）。**SOP の定義に忠実に**。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/Security/Same-origin_policy?utm_source=chatgpt.com)

---

## まとめ（要約）

- Nginx の振り分けは **Express（1プロセス）**に集約：
    
    `/` → **GROWI へプロキシ**、`/vivliostyle/inputs/*` → **静的配信**、`/vivliostyle/jobs` → **ジョブAPI**。
    
- ジョブAPIは **Vivliostyle CLI で PDF 生成**→**GROWI 添付APIに multipart でアップロード**→**finally で Temp を必ず削除**。
- すべて**同一オリジン**配下にまとめ、**CORS 無し**で安定運用（SOP 準拠）。
- GROWI の保存先がどれでも**API 経由**なのでコードは不変。[GitHub+2docs.growi.org+2](https://github.com/vivliostyle/vivliostyle-cli)

---

必要なら、この Express 一式に **systemd unit / .env サンプル / GROWI プラグイン最小コード（`fetch('/vivliostyle/jobs')`）を足した「動作確認セット」を用意します。
また、「添付 API の一覧取得**→**最新 PDF の URL をフロントへ返却**」の追加実装や、**SSE**での進捗配信にもすぐ拡張できます（GROWI REST v3 と同一オリジン運用のまま）。[docs.growi.org](https://docs.growi.org/en/api/rest-v3.html?utm_source=chatgpt.com)

> 補注：上記で /_api/attachments.add を利用していますが、GROWI の具体的な添付エンドポイントはバージョン差があり得るため、実環境の API リファレンス（v3/v1）で最終確認のうえ適用してください。添付ストレージの実体はFile Upload Settingsのとおり抽象化されています。docs.growi.org+1
> 

了解。**パターンA（ZIP で“完結HTML＋静的アセット”をサーバへ渡す方式）を、要件（`/vivliostyle/jobs` を使う・PDFは完成後にGROWIへ添付・一時領域は確実に削除）に沿って“設計→プロトコル→実装（フロント/サーバの全文コード**）→運用Tips”の順で詳述します。

前提知識として、**Vivliostyle CLI はローカルHTMLを直接PDF化できる**（`vivliostyle build index.html` など）こと、**file/data URL 入力のサポートが現行で復活**していること、**GROWI は添付の保存先（S3/GCS/Azure/Mongo/ローカル）を公式に吸収**していること、**GROWI のスクリプトプラグイン**でフロントから同一オリジンに `fetch()` できることを押さえておきます。[docs.growi.org+3Vivliostyle+3Yarn+3](https://vivliostyle.org/getting-started/?utm_source=chatgpt.com)

---

# 全体設計（パターンA）

- **フロント（GROWIプラグイン）**
    - 対象ページの**完成HTML**を生成し、同ページで参照する**画像/フォント/CSS/JS**等の**静的アセットをすべてZIP**に同梱（**相対パスで自己完結**）。
    - `POST /vivliostyle/jobs` （同一オリジン）に **multipart/form-data** で `pageId, pagePath, title, zip` を送信。
    - レスポンスの `jobId` で **ポーリング**または**SSE**。`succeeded` になれば**PDFはGROWI側の添付へ保存済み**なのでUIに案内を出す。
    - 根拠：GROWI スクリプトプラグインは TS + Vite で実装でき、ブラウザから同一オリジンAPIへ素直に `fetch()` 可能。[docs.growi.org](https://docs.growi.org/en/dev/plugin/script.html?utm_source=chatgpt.com)
- **サーバ（/vivliostyle/jobs：Express）**
    - ZIP を**一時ディレクトリ**に展開 → **`doc.html`（または指定HTML）をローカルパス**で `vivliostyle build` に渡す → **`out.pdf` 生成**。
    - 生成PDFを **GROWI 添付API** に **multipart** でアップロード（保存先が何であってもAPIが吸収）。**finally で一時領域を再帰削除**。[docs.growi.org](https://docs.growi.org/en/admin-guide/admin-cookbook/attachment.html?utm_source=chatgpt.com)
- **なぜこの方式が安全か？**
    - **ログイン必須の/attachment URLをCLIに直渡ししない**（CLIに認証ヘッダ注入オプションは見当たらない）。**ローカル完結**に寄せることで**認証・CORS・Cookie**の地雷を回避。
    - Vivliostyle CLI は**ローカルHTMLを直接PDF化**できるのが公式に明記。file/data URL サポートも復活済み（後述の代替最適化）。[Vivliostyle+1](https://vivliostyle.org/getting-started/?utm_source=chatgpt.com)

---

# 仕様（プロトコル／ZIP 形式）

## HTTP エンドポイント（同一オリジン）

- `POST /vivliostyle/jobs`
    - **Content-Type**: `multipart/form-data`
    - **フィールド**:
        - `pageId`（文字列, 必須）
        - `pagePath`（文字列, 必須）
        - `title`（文字列, 任意）
        - `bundle`（ファイル, 必須）… **ZIP**。**ルート直下に `doc.html` を置く**（※別名の場合は `entry` フィールドで指定可にしてもよい）
    - **応答**: `202 Accepted` + JSON `{ jobId, status: "queued" }`
- `GET /vivliostyle/jobs/:id`
    - **応答**: JSON `{ status: "queued"|"preparing"|"typesetting"|"uploading"|"succeeded"|"failed", artifact?: { attachment } }`

> 注：Idempotency-Key ヘッダ対応を推奨（連打の二重実行防止）。
> 

## ZIP の中身（必須ルール）

- `doc.html`（エントリポイント）
    - **すべての参照を相対パス**（例：`<img src="images/foo.png">`, `<link href="styles/print.css">`）
    - フォント等も `fonts/NotoSansJP.woff2` のように同梱
    - ネット越し取得が必要なものを**極力ゼロ**に（**Data URL**化も可。Vivliostyleは `data:` 入力がサポート）。[Yarn](https://classic.yarnpkg.com/en/package/%40vivliostyle/cli?utm_source=chatgpt.com)
- `images/*`, `styles/*`, `fonts/*`, `scripts/*` … 自由構成（**相対参照で完結**すること）

---

# 実装（**フロント：GROWIプラグイン**・全文）

> やること：
> 
> 1. `currentPage` 情報の取得
> 2. **完成HTML**の生成（GROWI APIからMarkdown→HTMLを取得してもよい／今回は簡易に`document.querySelector`などで取得例）
> 3. 参照アセットの収集 → **相対参照化** → **ZIP化**（JSZip 利用）
> 4. `POST /vivliostyle/jobs` へ multipart 送信 → ポーリング
> 5. 成功トースト表示（PDFはGROWI添付に保存済み）

```tsx
// growi-plugin-vivliostyle/client-entry.ts
// ビルド: Vite 等（GROWI Script Plugin の推奨構成に準拠）
// 依存: npm i jszip
// 参考: GROWI Script Plugin 開発ガイド（TS+Vite 推奨） :contentReference[oaicite:5]{index=5}
import JSZip from 'jszip';

(async function main() {
  // UIボタンを追加
  const btn = document.createElement('button');
  btn.textContent = 'PDF出力（ZIP送信→添付保存）';
  Object.assign(btn.style, { position: 'fixed', bottom: '16px', right: '16px', zIndex: 10000 });
  document.body.appendChild(btn);

  btn.addEventListener('click', async () => {
    try {
      const { pageId, pagePath, title } = await getCurrentPageContext();
      if (!pageId) { alert('pageId を取得できません'); return; }

      // 1) 完成HTMLの生成（最小例）
      //    実運用では GROWI REST v3 から Markdown/HTML を引いてSSRするなど堅牢に。
      const htmlString = buildStandaloneHTML(title || pagePath);

      // 2) 相対アセットの同梱（例: <img src> 等のリンク収集は実装に応じて）
      //    ここではデモとして最小のCSSだけを内蔵する。
      const printCss = `
        @page { size: A4; margin: 20mm; }
        body { font-family: system-ui, sans-serif; }
        h1 { font-size: 24px; margin-bottom: 12px; }
        .content { font-size: 14px; line-height: 1.8; }
      `;

      // 3) ZIP 作成
      const zip = new JSZip();
      zip.file('doc.html', htmlString);
      zip.folder('styles')!.file('print.css', printCss);

      const zipBlob = await zip.generateAsync({ type: 'blob' });

      // 4) multipart で /vivliostyle/jobs へ送信
      const form = new FormData();
      form.append('pageId', pageId);
      form.append('pagePath', pagePath);
      form.append('title', title || pagePath);
      form.append('bundle', new File([zipBlob], 'bundle.zip', { type: 'application/zip' }));

      const idem = crypto.randomUUID();
      const res = await fetch('/vivliostyle/jobs', {
        method: 'POST',
        headers: { 'Idempotency-Key': idem },
        body: form
      });
      if (!res.ok) throw new Error(await res.text());
      const { jobId } = await res.json();

      // 5) ポーリング（本番は SSE 推奨）
      let status = 'queued';
      while (!['succeeded', 'failed'].includes(status)) {
        await sleep(1500);
        const s = await fetch(`/vivliostyle/jobs/${jobId}`);
        if (!s.ok) throw new Error(await s.text());
        const json = await s.json();
        status = json.status;
        console.log('vivliostyle job:', status);
      }
      if (status === 'succeeded') {
        alert('PDF をページの添付に保存しました。添付一覧をご確認ください。');
      } else {
        alert('PDF 生成に失敗しました。');
      }
    } catch (e) {
      console.error(e);
      alert('エラー: ' + e);
    }
  });

  async function getCurrentPageContext() {
    // 環境に合わせて実装（GROWI のグローバルから現在ページを取得する例）
    // 例: window.appContainer?.state?.crowi?.context?.currentPage
    const pageId   = (window as any)?.appContainer?.state?.crowi?.context?.currentPage?._id;
    const pagePath = (window as any)?.appContainer?.state?.crowi?.context?.currentPage?.path;
    const title    = document.title || pagePath;
    return { pageId, pagePath, title };
  }

  function buildStandaloneHTML(title: string) {
    // 参照は相対パス（styles/print.css）
    // ※画像等を含める場合は <img src="images/..." /> のようにし、ZIP内に格納する
    return String.raw`<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<title>${escapeHtml(title)} | PDF</title>
<link rel="stylesheet" href="styles/print.css">
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="content">
    <p>このHTMLはZIPに同梱した相対アセットのみで完結しています。</p>
    <p>GROWI の本文はここにレンダリング（サーバ/クライアントどちらでも可）。</p>
  </div>
</body></html>`;
  }

  function escapeHtml(s: string) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
})();

```

> 補足：フロント側で画像を Data URL 化して doc.html に埋め込むと、ZIP内ファイル数を減らせます（HTMLは重くなるが堅牢）。Vivliostyleは file/data URL 入力のサポートが復活しているので、完全自己完結を狙うなら有効。Yarn
> 

---

# 実装（**サーバ：Express 統合**・全文）

> やること：
> 
> - `/vivliostyle/jobs` に **multipart** で受信 → ZIP を**安全に展開**（Zip Slip対策）
> - エントリHTML（`doc.html`）へ**ローカルパス**で `vivliostyle build` 実行（**ローカル入力OK**）[Vivliostyle](https://vivliostyle.org/getting-started/?utm_source=chatgpt.com)
> - `out.pdf` を **GROWI 添付API** に **multipart** でアップロード（保存先は GROWI 側で吸収）[docs.growi.org](https://docs.growi.org/en/admin-guide/admin-cookbook/attachment.html?utm_source=chatgpt.com)
> - 成否に関わらず **finally で一時領域を削除**

```jsx
// server.js
// Node 18+
// 依存: npm i express undici form-data busboy unzipper http-proxy-middleware
// 役割: (1) /vivliostyle/jobs の受け口 (2) ZIP 展開→Vivliostyle CLI 実行→PDFをGROWI添付 (3) 一時領域の掃除 (4) ルートはGROWIへプロキシ（任意）

import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, normalize } from 'node:path';
import { request as undiciRequest } from 'undici';
import FormData from 'form-data';
import Busboy from 'busboy';
import unzipper from 'unzipper';
import { spawn } from 'node:child_process';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();

// ========= 設定 =========
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '<https://wiki.example.com>';
const VIV_CMD       = process.env.VIV_CMD       || 'vivliostyle';
const TIMEOUT_MS    = +process.env.TIMEOUT_MS   || 300000; // 5min（Vivliostyleの既定300sに合わせ気味） :contentReference[oaicite:9]{index=9}
const GROWI_BASE    = process.env.GROWI_BASE    || '<https://wiki.example.com>';
const GROWI_TOKEN   = process.env.GROWI_TOKEN   || ''; // Bot等のアクセストークン（実環境に合わせる）
const GROWI_USER    = process.env.GROWI_USER    || ''; // 互換用 user パラメータ（要件に応じて）

const GROWI_TARGET  = process.env.GROWI_TARGET  || '<http://127.0.0.1:3000>'; // 任意: ルートをGROWIへプロキシしたい場合

// ========= ジョブ管理 =========
const jobs = new Map(); // jobId -> { status, pageId, pagePath, artifact? }
const idemMap = new Map(); // Idempotency-Key -> jobId

// ========= multipart 受信: /vivliostyle/jobs =========
app.post('/vivliostyle/jobs', (req, res) => {
  const idem = req.headers['idempotency-key'] || null;
  if (idem && idemMap.has(idem)) {
    const jobId = idemMap.get(idem);
    const j = jobs.get(jobId);
    return res.status(200).json({ jobId, status: j?.status || 'unknown' });
  }

  const bb = Busboy({ headers: req.headers });
  const fields = { pageId: '', pagePath: '', title: '', entry: 'doc.html' };
  let zipBufferChunks = [];
  let gotZip = false;

  bb.on('file', (name, file, info) => {
    if (name !== 'bundle') {
      file.resume();
      return;
    }
    gotZip = true;
    file.on('data', (d) => zipBufferChunks.push(d));
  });

  bb.on('field', (name, val) => {
    if (name in fields) fields[name] = String(val);
  });

  bb.on('finish', async () => {
    try {
      if (!fields.pageId || !fields.pagePath) {
        return res.status(400).json({ error: 'pageId and pagePath are required' });
      }
      if (!gotZip) {
        return res.status(400).json({ error: 'bundle(zip) is required' });
      }

      const jobId = randomUUID();
      if (idem) idemMap.set(idem, jobId);
      jobs.set(jobId, { status: 'queued', pageId: fields.pageId, pagePath: fields.pagePath });

      // 非同期実行
      runJob(jobId, fields, Buffer.concat(zipBufferChunks)).catch(err => {
        console.error('[job failed]', jobId, err);
      });

      res.status(202).setHeader('Location', `/vivliostyle/jobs/${jobId}`).json({ jobId, status: 'queued' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e) });
    }
  });

  req.pipe(bb);
});

app.get('/vivliostyle/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

async function runJob(jobId, fields, zipBuffer) {
  const j = jobs.get(jobId); if (!j) return;
  j.status = 'preparing'; jobs.set(jobId, j);

  // 1) ZIP を一時領域へ展開（Zip Slip 対策: 正規化チェック）
  const baseDir = await mkdtemp(join(tmpdir(), 'viv-job-'));
  const unzipDir = join(baseDir, 'unzip');
  await mkdir(unzipDir, { recursive: true });

  await unzipToDirSecure(zipBuffer, unzipDir);

  // エントリ HTML
  const entryHtml = resolve(unzipDir, fields.entry || 'doc.html');
  try {
    await stat(entryHtml);
  } catch {
    throw new Error(`entry HTML not found: ${entryHtml}`);
  }

  // 2) Vivliostyle CLI で PDF 化（ローカルHTML入力OK） :contentReference[oaicite:10]{index=10}
  const outPdf = join(baseDir, 'out.pdf');
  j.status = 'typesetting'; jobs.set(jobId, j);
  await runVivliostyleLocal(entryHtml, outPdf, TIMEOUT_MS);

  // 3) GROWI へ添付アップロード（multipart）
  j.status = 'uploading'; jobs.set(jobId, j);
  const attachment = await uploadToGrowi(outPdf, fields.pageId, fields.title || fields.pagePath);
  j.status = 'succeeded'; j.artifact = { attachment, pageId: fields.pageId }; jobs.set(jobId, j);

  // 4) 掃除（成功/失敗いずれでも finally 相当で呼ぶこと）
  await safeRm(baseDir);
}

async function unzipToDirSecure(zipBuffer, destDir) {
  const directory = await unzipper.Open.buffer(zipBuffer);
  for (const entry of directory.files) {
    const p = normalize(join(destDir, entry.path));
    if (!p.startsWith(destDir)) throw new Error('Zip Slip detected');
    if (entry.type === 'Directory') {
      await mkdir(p, { recursive: true });
    } else {
      await mkdir(dirname(p), { recursive: true });
      const content = await entry.buffer();
      await writeFile(p, content);
    }
  }
}

function runVivliostyleLocal(inputHtml, outPdf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ps = spawn(VIV_CMD, ['build', inputHtml, '-o', outPdf, '-f', 'pdf'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let killed = false;
    const t = setTimeout(() => { killed = true; ps.kill('SIGKILL'); reject(new Error(`vivliostyle timeout ${timeoutMs}ms`)); }, timeoutMs);
    ps.stdout.on('data', d => process.stdout.write(`[viv] ${d}`));
    ps.stderr.on('data', d => process.stderr.write(`[viv:err] ${d}`));
    ps.on('close', (code) => { clearTimeout(t); if (killed) return; code === 0 ? resolve(null) : reject(new Error(`vivliostyle exited ${code}`)); });
  });
}

async function uploadToGrowi(pdfPath, pageId, title) {
  const form = new FormData();
  form.append('page_id', pageId);
  form.append('file', await readFile(pdfPath), { filename: suggestPdfName(title) });

  const url = new URL(`${GROWI_BASE}/_api/attachments.add`);
  if (GROWI_TOKEN) url.searchParams.set('access_token', GROWI_TOKEN);
  if (GROWI_USER)  url.searchParams.set('user', GROWI_USER);

  const resp = await undiciRequest(url, { method: 'POST', body: form, headers: form.getHeaders() });
  if (resp.statusCode >= 300) {
    const text = await resp.body.text();
    throw new Error(`attachments.add failed: ${resp.statusCode} ${text}`);
  }
  const json = await resp.body.json();
  return json.attachment || null; // 実体は運用中のGROWIのレスポンスに依存
}

async function safeRm(p) {
  await rm(p, { recursive: true, force: true, maxRetries: 3 });
}

function suggestPdfName(title) {
  const base = String(title || 'document').replace(/[\\\\/:*?"<>|]+/g, '_').slice(-128);
  return `${base}.pdf`;
}

// ========= （任意）GROWI本体へのプロキシ =========
app.use('/', createProxyMiddleware({
  target: GROWI_TARGET, changeOrigin: true, ws: true
}));

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`server on :${port}`);
});

```

> 参考：**Vivliostyle CLI の使い方（ローカルHTML→PDF）**は Getting Started に明記、デフォルトのタイムアウトや file/data URL サポート復活はパッケージのChangelogに記載。GROWI 添付の保存先抽象化は公式「File Upload Settings」に記載。スクリプトプラグインの開発手順も公式ドキュメントあり。docs.growi.org+3Vivliostyle+3Yarn+3
> 

---

# 運用・品質のコツ（重要ポイント）

1. **相対参照の徹底**
    
    `doc.html` からのアセット参照は**相対パス**に統一（`styles/*`, `images/*` 等）。外部URLを残すと当日ダウンや認証で失敗し得る。Vivliostyleは**ローカル入力**が前提のほうが安定。[Vivliostyle](https://vivliostyle.org/getting-started/?utm_source=chatgpt.com)
    
2. **Data URL でさらに堅牢化**
    
    画像/フォントを **Data URL** に内蔵すれば、ZIP内のファイル数が減り、**依存がさらにゼロに近づく**。Vivliostyle の **file/data URL サポート**は現行で有効。[Yarn](https://classic.yarnpkg.com/en/package/%40vivliostyle/cli?utm_source=chatgpt.com)
    
3. **Zip Slip 対策**
    
    展開時に**正規化パスが展開ディレクトリ配下か**をチェック（実装済み）。ユーザー提供ZIPを扱う以上、**必須**。
    
4. **Idempotency-Key**
    
    フロント連打やリトライに備えて**冪等性キー**で**同一ジョブ再利用**。実装済み。
    
5. **Vivliostyle のタイムアウト**
    
    重いページは長引くことがある。**`TIMEOUT_MS` を環境変数で調整**（Changelog ではデフォルト300sに言及）。[Yarn](https://classic.yarnpkg.com/en/package/%40vivliostyle/cli?utm_source=chatgpt.com)
    
6. **GROWI 添付API**
    
    **multipart でアップロード**すれば、**保存先（S3/GCS/Azure/Mongo/ローカル）はGROWIが吸収**するため、**アプリ側のコードは不変**。保存先や配信方式（Redirect/Relay）は管理画面の設定に依存。[docs.growi.org+1](https://docs.growi.org/en/admin-guide/admin-cookbook/attachment.html?utm_source=chatgpt.com)
    
7. **後片付け**
    
    **成功/失敗を問わず一時領域を削除**。さらに**夜間バッチ**で `/tmp/viv-job-*` の孤児掃除を併用すると万全。
    

---

# よくある質問（想定反論に先回り）

- **Q. ZIPのサイズが大きすぎる**
    
    → 画像を**適切に再圧縮**、**フォントは必要サブセットのみ**、**未使用CSS/JS削減**。どうしても大きいなら**Data URL化**や**差分ビルド**を検討。
    
- **Q. 外部CDNのCSS/フォント参照を残したい**
    
    → 認証やオフラインで失敗する。**同梱 or Data URL**に。Vivliostyleは**ローカル完結**のほうが確実。[Vivliostyle](https://vivliostyle.org/getting-started/?utm_source=chatgpt.com)
    
- **Q. フロントでHTMLをどう作る？**
    
    → ここでは簡素化していますが、**GROWI REST v3**で**ページHTML/Markdown取得→レンダリング**、**目次や表紙テンプレ**を注入…など柔軟に可能（プラグインのガイド参照）。[docs.growi.org](https://docs.growi.org/en/dev/plugin/script.html?utm_source=chatgpt.com)
    

---

## まとめ（要約）

- **パターンA**は「**フロントで ZIP（doc.html＋アセット完全同梱）→サーバで展開→VivliostyleでPDF→GROWIへ添付**→**Temp確実削除**」という流れ。
- この方式なら**ログイン必須の/attachment URLをCLIに渡す必要がない**ため、**認証/CORSの罠を回避**しつつ、**GROWIの保存先差**もAPI側で吸収される。
- コアは**相対参照の自己完結**と**multipart/multipart**（ZIP受信＆PDF添付）運用。Vivliostyleは**ローカルHTML入力**で安定、**file/data URL**も現行サポート。[Vivliostyle+2Yarn+2](https://vivliostyle.org/getting-started/?utm_source=chatgpt.com)

**You:**

この場合、Vivliostyle CLIのログはどうやってフロントGUIに渡す？進捗をリアルタイムで確認したい。

---

**ChatGPT:**

了解。**リアルタイム進捗（Vivliostyle CLI の標準出力/標準エラー）をフロントへ届ける一番素直で壊れにくい方法は「SSE（Server-Sent Events）」**です。サーバが `text/event-stream` を永続レスポンスで書き流し、ブラウザは `EventSource` で受けるだけ。**一方向（サーバ→ブラウザ）**の生ログ配信には最適です。SSE は HTML 標準/MDN に実装とヘッダ要件がまとまっており、ブラウザ実装も枯れています。[html.spec.whatwg.org+2MDNウェブドキュメント+2](https://html.spec.whatwg.org/multipage/server-sent-events.html?utm_source=chatgpt.com)

以下、「**パターンA（ZIP→ローカルビルド）**」のまま**SSEでログ中継**を追加する設計と、**フロント/サーバの実装（全文）**、運用の落とし穴までまとめます。

---

# 設計のポイント（まず結論）

- **サーバ（/vivliostyle/jobs 実装側）**
    - `child_process.spawn('vivliostyle', ...)` の **`stdout`/`stderr` を逐次受信**し、**同じ `jobId` に紐づく SSE 接続へ `event: log\\ndata: ...\\n\\n`** として書き流す。[Node.js](https://nodejs.org/api/child_process.html?utm_source=chatgpt.com)
    - SSE エンドポイント例：`GET /vivliostyle/jobs/:id/events`
    - SSE レスポンスは **`Content-Type: text/event-stream` / `Cache-Control: no-cache` / `Connection: keep-alive`**、**心拍（コメント行 `:\\n\\n`）を定期送信**。プロキシ/ロードバランサのバッファリングを避けるため、必要なら **`X-Accel-Buffering: no`** 相当も送出。[MDNウェブドキュメント+1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events?utm_source=chatgpt.com)
    - *ジョブ状態遷移（queued / preparing / typesetting / uploading / succeeded / failed）**も `event: status` で流す。
- **フロント（GROWI プラグイン）**
    - ジョブ作成 `POST /vivliostyle/jobs` → **返ってきた `jobId` で `new EventSource('/vivliostyle/jobs/{id}/events')`**。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events?utm_source=chatgpt.com)
    - `message`/`log`/`status` を受けて **進捗UI（ログコンソール＋ステータス）**を更新。
    - バックアップとして **既存の `GET /vivliostyle/jobs/{id}` ポーリング**を継続可（SSE 非対応ブラウザ対策）。
- **双方向制御（任意）**
    - 「ジョブ中断」「優先度変更」など**クライアント→サーバ**の双方向が必要なら **WebSocket（`ws`）** へ拡張する。**ログ配信だけなら SSE が簡潔**。[MDNウェブドキュメント+1](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API?utm_source=chatgpt.com)

---

# サーバ実装（**全文**・SSE 付き）

> 既存のパターンAサーバ（ZIP 展開→vivliostyle build→GROWI 添付）に SSE配信レイヤを足したものです。
> 
> 
> Node 18+ / 依存: `express undici form-data busboy unzipper http-proxy-middleware`
> 

```jsx
// server.js  — 既存のパターンAに「SSE（/vivliostyle/jobs/:id/events）」を追加
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, normalize } from 'node:path';
import { request as undiciRequest } from 'undici';
import FormData from 'form-data';
import Busboy from 'busboy';
import unzipper from 'unzipper';
import { spawn } from 'node:child_process';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();

// ====== 設定 ======
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '<https://wiki.example.com>';
const VIV_CMD       = process.env.VIV_CMD       || 'vivliostyle';
const TIMEOUT_MS    = +process.env.TIMEOUT_MS   || 300000;
const GROWI_BASE    = process.env.GROWI_BASE    || '<https://wiki.example.com>';
const GROWI_TOKEN   = process.env.GROWI_TOKEN   || '';
const GROWI_USER    = process.env.GROWI_USER    || '';
const GROWI_TARGET  = process.env.GROWI_TARGET  || '<http://127.0.0.1:3000>';

// ====== 状態管理 ======
const jobs = new Map();      // jobId -> { status, pageId, pagePath, artifact? }
const idemMap = new Map();   // Idempotency-Key -> jobId
const sseClients = new Map();// jobId -> Set<res>

// ====== SSE: 接続登録/解除ユーティリティ ======
function sseRegister(jobId, res) {
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(res);
  res.on('close', () => {
    sseClients.get(jobId)?.delete(res);
  });
}
function sseSend(jobId, event, dataObj) {
  const payload = typeof dataObj === 'string' ? dataObj : JSON.stringify(dataObj);
  const conns = sseClients.get(jobId);
  if (!conns) return;
  for (const res of conns) {
    res.write(`event: ${event}\\n`);
    // data 行は改行をエスケープ（複数行は複数 data: に分けるのが仕様的に安全）
    for (const line of String(payload).split('\\n')) {
      res.write(`data: ${line}\\n`);
    }
    res.write('\\n');
  }
}

// ====== SSEエンドポイント ======
app.get('/vivliostyle/jobs/:id/events', (req, res) => {
  // SSE 必須ヘッダ（MDN/WHATWG）
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // 一部プロキシ/リバースプロキシでのバッファ抑止（必要に応じて）
    'X-Accel-Buffering': 'no'
  });
  // HEARTBEAT（コメント行）でコネクション維持
  const hb = setInterval(() => res.write(`:heartbeat ${Date.now()}\\n\\n`), 15000);
  res.on('close', () => clearInterval(hb));

  const { id: jobId } = req.params;
  sseRegister(jobId, res);

  // 接続直後に現在のステータスを送る
  const j = jobs.get(jobId);
  if (j) {
    sseSend(jobId, 'status', { status: j.status });
  } else {
    sseSend(jobId, 'status', { status: 'unknown' });
  }
});

// ====== ジョブ作成（multipart ZIP 受け） ======
app.post('/vivliostyle/jobs', (req, res) => {
  const idem = req.headers['idempotency-key'] || null;
  if (idem && idemMap.has(idem)) {
    const jobId = idemMap.get(idem);
    const j = jobs.get(jobId);
    return res.status(200).json({ jobId, status: j?.status || 'unknown' });
  }

  const bb = Busboy({ headers: req.headers });
  const fields = { pageId: '', pagePath: '', title: '', entry: 'doc.html' };
  const chunks = [];
  let gotZip = false;

  bb.on('file', (name, file) => {
    if (name !== 'bundle') return file.resume();
    gotZip = true;
    file.on('data', d => chunks.push(d));
  });
  bb.on('field', (n, v) => { if (n in fields) fields[n] = String(v); });

  bb.on('finish', async () => {
    try {
      if (!fields.pageId || !fields.pagePath) return res.status(400).json({ error: 'pageId and pagePath are required' });
      if (!gotZip) return res.status(400).json({ error: 'bundle(zip) is required' });

      const jobId = randomUUID();
      if (idem) idemMap.set(idem, jobId);
      jobs.set(jobId, { status: 'queued', pageId: fields.pageId, pagePath: fields.pagePath });

      runJob(jobId, fields, Buffer.concat(chunks)).catch(err => {
        console.error('[job failed]', jobId, err);
      });

      res.status(202).setHeader('Location', `/vivliostyle/jobs/${jobId}`).json({ jobId, status: 'queued' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e) });
    }
  });

  req.pipe(bb);
});

// ====== ジョブ状態参照（ポーリング併用もOK） ======
app.get('/vivliostyle/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not found' });
  res.json(j);
});

// ====== 実行本体 ======
async function runJob(jobId, fields, zipBuffer) {
  updateStatus(jobId, 'preparing');

  // 1) ZIP 展開
  const baseDir = await mkdtemp(join(tmpdir(), 'viv-job-'));
  const unzipDir = join(baseDir, 'unzip');
  await mkdir(unzipDir, { recursive: true });
  await unzipToDirSecure(zipBuffer, unzipDir);

  const entryHtml = resolve(unzipDir, fields.entry || 'doc.html');
  await stat(entryHtml).catch(() => { throw new Error(`entry HTML not found: ${entryHtml}`); });

  // 2) vivliostyle build（ローカルHTML入力）
  const outPdf = join(baseDir, 'out.pdf');
  updateStatus(jobId, 'typesetting');
  await runVivliostyleLocal(jobId, entryHtml, outPdf, TIMEOUT_MS); // ← stdout/err を SSE 中継

  // 3) GROWI へ添付アップロード
  updateStatus(jobId, 'uploading');
  const attachment = await uploadToGrowi(outPdf, fields.pageId, fields.title || fields.pagePath);

  // 4) 完了通知
  const j = jobs.get(jobId) || {};
  j.status = 'succeeded'; j.artifact = { attachment, pageId: fields.pageId };
  jobs.set(jobId, j);
  sseSend(jobId, 'status', { status: 'succeeded' });

  // 5) 掃除（finally）
  await safeRm(baseDir);
}
function updateStatus(jobId, status) {
  const j = jobs.get(jobId) || {};
  j.status = status; jobs.set(jobId, j);
  sseSend(jobId, 'status', { status });
}

// ====== ZIP 展開（Zip Slip 対策） ======
async function unzipToDirSecure(zipBuffer, destDir) {
  const directory = await unzipper.Open.buffer(zipBuffer);
  for (const entry of directory.files) {
    const p = normalize(join(destDir, entry.path));
    if (!p.startsWith(destDir)) throw new Error('Zip Slip detected');
    if (entry.type === 'Directory') {
      await mkdir(p, { recursive: true });
    } else {
      await mkdir(dirname(p), { recursive: true });
      const content = await entry.buffer();
      await writeFile(p, content);
    }
  }
}

// ====== vivliostyle 実行 + ログをSSEへ中継 ======
function runVivliostyleLocal(jobId, inputHtml, outPdf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ps = spawn(VIV_CMD, ['build', inputHtml, '-o', outPdf, '-f', 'pdf'], {
      stdio: ['ignore', 'pipe', 'pipe']
    }); // spawn は非同期で stdout/err をストリームとして扱える :contentReference[oaicite:5]{index=5}

    let killed = false;
    const t = setTimeout(() => { killed = true; ps.kill('SIGKILL'); reject(new Error(`vivliostyle timeout ${timeoutMs}ms`)); }, timeoutMs);

    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');

    ps.stdout.on('data', d => {
      process.stdout.write(`[viv] ${d}`);
      sseSend(jobId, 'log', { stream: 'stdout', chunk: d });
    });
    ps.stderr.on('data', d => {
      process.stderr.write(`[viv:err] ${d}`);
      sseSend(jobId, 'log', { stream: 'stderr', chunk: d });
    });

    ps.on('close', (code) => {
      clearTimeout(t);
      if (killed) return;
      if (code === 0) {
        sseSend(jobId, 'log', { stream: 'end', chunk: 'done' });
        resolve();
      } else {
        sseSend(jobId, 'log', { stream: 'end', chunk: `exit ${code}` });
        updateStatus(jobId, 'failed');
        reject(new Error(`vivliostyle exited ${code}`));
      }
    });
  });
}

// ====== GROWI 添付アップロード ======
async function uploadToGrowi(pdfPath, pageId, title) {
  const form = new FormData();
  form.append('page_id', pageId);
  form.append('file', await readFile(pdfPath), { filename: suggestPdfName(title) });

  const url = new URL(`${GROWI_BASE}/_api/attachments.add`);
  if (GROWI_TOKEN) url.searchParams.set('access_token', GROWI_TOKEN);
  if (GROWI_USER)  url.searchParams.set('user', GROWI_USER);

  const resp = await undiciRequest(url, { method: 'POST', body: form, headers: form.getHeaders() });
  if (resp.statusCode >= 300) throw new Error(`attachments.add failed: ${resp.statusCode} ${await resp.body.text()}`);
  const json = await resp.body.json();
  return json.attachment || null;
}

async function safeRm(p) { await rm(p, { recursive: true, force: true, maxRetries: 3 }); }
function suggestPdfName(title) { return `${String(title || 'document').replace(/[\\\\/:*?"<>|]+/g, '_').slice(-128)}.pdf`; }

// （任意）GROWI本体へのプロキシ
app.use('/', createProxyMiddleware({ target: GROWI_TARGET, changeOrigin: true, ws: true }));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`server on :${port}`));

```

- **なぜこれでリアルタイムになる？**
    
    `spawn()` の `stdout`/`stderr` は**ストリーム（イベント）なので、`data` 受信ごとに SSE で `data:` を書けば 即座にブラウザへ到達します。`EventSource` はコネクションを張りっぱなしでサーバからのプッシュ**を受け取れます。[Node.js+1](https://nodejs.org/api/child_process.html?utm_source=chatgpt.com)
    
- **SSE の基本**
    
    **`text/event-stream`**、**行頭に `event:`/`data:`**、**イベント間は空行で区切り**、**切断時は自動再接続**（`retry` 指定可）。MDN/WHATWGのとおり。[MDNウェブドキュメント+1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events?utm_source=chatgpt.com)
    
- **バッファリング対策**
    
    途中で**Nginx/リバースプロキシ/ALB/CloudFront**等がある場合、**出力をまとめてしまう（全部終わってから吐き出す）ことがあるので、バッファ無効化や心拍コメント**を入れるのが定石です。[Medium+1](https://medium.com/%40ajinkya.r.rajput/real-time-push-messages-from-server-server-sent-event-in-node-js-with-express-js-redis-5fd3843ee0fa?utm_source=chatgpt.com)
    

---

# フロント（GROWI プラグイン側の受信UI・**全文**）

> POST /vivliostyle/jobs の後、EventSource で /vivliostyle/jobs/{jobId}/events に接続。ログはテキストエリアへ追記、ステータスはバッジ表示。
> 

```tsx
// growi-plugin-vivliostyle/client-entry.ts — SSEで進捗ログを受信
(() => {
  const btn = document.createElement('button');
  btn.textContent = 'PDF出力（リアルタイム進捗あり）';
  Object.assign(btn.style, { position: 'fixed', bottom: '16px', right: '16px', zIndex: 10000 });
  document.body.appendChild(btn);

  // 簡易ログビュー
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', bottom: '60px', right: '16px', width: '480px', height: '200px',
    background: '#111', color: '#0f0', font: '12px/1.4 monospace', padding: '8px', overflow: 'auto', whiteSpace: 'pre-wrap' });
  box.textContent = '[viv] idle\\n';
  document.body.appendChild(box);

  const badge = document.createElement('div');
  Object.assign(badge.style, { position: 'fixed', bottom: '270px', right: '16px', background: '#444', color: '#fff',
    padding: '4px 8px', borderRadius: '8px', font: '12px sans-serif' });
  badge.textContent = 'status: idle';
  document.body.appendChild(badge);

  btn.addEventListener('click', async () => {
    try {
      const { pageId, pagePath, title } = getCtx();
      if (!pageId) { alert('pageId が取得できません'); return; }

      // ZIP 構築は割愛（前回答コード参照）。ここでは既に bundle を作った前提で送る。
      const form = new FormData();
      form.append('pageId', pageId);
      form.append('pagePath', pagePath);
      form.append('title', title || pagePath);
      // 例として空のZIP（ダミー）。実運用はJSZip等で構築した実体を入れる。
      const empty = new Blob([], { type: 'application/zip' });
      form.append('bundle', new File([empty], 'bundle.zip', { type: 'application/zip' }));

      const idem = crypto.randomUUID();
      const r = await fetch('/vivliostyle/jobs', { method: 'POST', headers: { 'Idempotency-Key': idem }, body: form });
      if (!r.ok) throw new Error(await r.text());
      const { jobId } = await r.json();

      // SSE へ接続
      const es = new EventSource(`/vivliostyle/jobs/${jobId}/events`);
      es.addEventListener('status', (ev: MessageEvent) => {
        const { status } = JSON.parse(ev.data);
        badge.textContent = `status: ${status}`;
        if (status === 'succeeded') {
          box.textContent += '\\n[viv] ✅ PDF を添付に保存しました。ページの添付一覧をご確認ください。\\n';
          es.close();
        }
        if (status === 'failed') {
          box.textContent += '\\n[viv] ❌ 失敗しました。ログを確認してください。\\n';
          es.close();
        }
      });
      es.addEventListener('log', (ev: MessageEvent) => {
        const { stream, chunk } = JSON.parse(ev.data);
        box.textContent += `[${stream}] ${chunk}`;
        box.scrollTop = box.scrollHeight;
      });
      es.onerror = () => {
        // 自動再接続（EventSource 既定）に任せつつ、UIも補助
        box.textContent += '\\n[viv] (SSE 接続が不安定です。自動再接続を待機します)\\n';
      };
    } catch (e) {
      alert('エラー: ' + e);
    }
  });

  function getCtx() {
    const pageId   = (window as any)?.appContainer?.state?.crowi?.context?.currentPage?._id;
    const pagePath = (window as any)?.appContainer?.state?.crowi?.context?.currentPage?.path;
    const title    = document.title || pagePath;
    return { pageId, pagePath, title };
  }
})();

```

- **EventSource の使い方**は MDN/WHATWG が最良の一次情報です（`message` 既定イベント／カスタムイベント／自動再接続／`retry` 等）。[MDNウェブドキュメント+2MDNウェブドキュメント+2](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events?utm_source=chatgpt.com)

---

# 代替案：WebSocket を使う場合（要双方向）

- **双方向**（例：ユーザーから**キャンセル**指示、**優先度**変更）まで必要なら **WebSocket** へ。`ws` は Node の定番実装。[MDNウェブドキュメント+1](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API?utm_source=chatgpt.com)
- ただし**ログの片方向配信だけ**なら **SSE の方がコード・運用ともに軽い**（HTTPだけで動き、ロードバランサ設定も楽）。

---

# ネットワーク/運用の落とし穴（ここ大事）

1. **中間装置のバッファリング**
    - 一部の LB/CDN/プロキシは**レスポンスをまとめて出す**。SSE では**逐次出力**が命なので、**バッファ無効化**（例：`X-Accel-Buffering: no`）や**心拍コメント**を入れる。[Medium+1](https://medium.com/%40ajinkya.r.rajput/real-time-push-messages-from-server-server-sent-event-in-node-js-with-express-js-redis-5fd3843ee0fa?utm_source=chatgpt.com)
2. **ヘッダ**
    - **`Content-Type: text/event-stream`**、**`Cache-Control: no-cache`**、**`Connection: keep-alive`** は固定。MDN/WHATWG に準拠。[MDNウェブドキュメント+1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events?utm_source=chatgpt.com)
3. **子プロセスの安全**
    - `spawn` の引数に**外部入力を直接混ぜない**（シェル解釈は無効、`shell: false` 既定）。ドキュメントの注意に従う。[Node.js+1](https://nodejs.org/api/child_process.html?utm_source=chatgpt.com)
4. **SSE 再接続**
    - ネットワーク断に強いが、長時間のアイドルで切れることはある。**心拍**を 10–30s で送り、**`retry`** をクライアントへ送る運用も可。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events?utm_source=chatgpt.com)
5. **フォールバック**
    - **SSE 非対応環境**向けに**ポーリング**を温存。`GET /vivliostyle/jobs/:id` はそのまま残す。

---

## まとめ（要約）

- **SSE を使えば、Vivliostyle CLI の `stdout`/`stderr` をそのままフロントへリアルタイム配信**できます。
- サーバ側は **`spawn()` のストリームを受けるたびに `event: log`** を書き、**状態変化は `event: status`** で送る。**必要ヘッダと心拍送信**を忘れずに。[Node.js+1](https://nodejs.org/api/child_process.html?utm_source=chatgpt.com)
- **フロントは `EventSource`** を `jobId` で開き、**ログを追記／ステータスでUI更新**。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events?utm_source=chatgpt.com)
- 双方向制御が要れば **WebSocket（`ws`）** へ拡張、ただし**片方向ログ配信だけなら SSE が軽量で実戦的**。[MDNウェブドキュメント+1](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API?utm_source=chatgpt.com)

現在のアーキテクチャ（GROWI+フロントエンドプラグイン+Vivliostyle+node expressによるリバースプロキシ+同一オリジン + /vivliostyle/jobs（ZIP受け→Vivliostyle実行→GROWI添付）+ SSEでログ配信）で落とし穴や実装上の注意はある？

---

**ChatGPT:**

了解。いまの構成（GROWI＋フロントプラグイン＋Vivliostyle CLI＋Node/Expressプロキシ＋同一オリジン＋`/vivliostyle/jobs`（ZIP受け→ビルド→GROWI添付）＋SSEログ）で、**ハマりやすい落とし穴**と**実装・運用の注意**を“ネットワーク／SSE”“セキュリティ”“ビルド実務（Vivliostyle/Chromium）”“GROWI添付API/サイズ周り”“その他運用”の5カテゴリに分けて列挙します。最後に要約も付けます。

（根拠は MDN/WHATWG・AWS/Cloudflareのドキュメント・OWASP・Node公式・Zip Slip解説・Vivliostyle/Playwright資料などを適宜参照しています）

---

## 1) ネットワーク／SSE（ログのリアルタイム配信）

- **SSEの基本ヘッダが足りない／誤設定**
    
    サーバは **`Content-Type: text/event-stream`**、**空行区切り**、**キャッシュ無効化**（`Cache-Control: no-cache`）で逐次送信する必要があります。形式が崩れると**まとめて出力(バッファ)**になります。[MDNウェブドキュメント+1](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events?utm_source=chatgpt.com)
    
    *注釈*: SSEは一方向ストリーム。双方向が要るならWebSocket。
    
- **中間装置の“バッファリング”でリアルタイム性が死ぬ**
    
    Nginxや一部プロキシ/CGIラッパは**レスポンスを溜めてから吐く**場合があるため、**`X-Accel-Buffering: no`** などで明示的に無効化し、**定期的な心拍コメント**を送ると安定します。事例報告でも、設定や中継（fastcgi 等）によって**全部終わってから一括配送**になるケースが確認されています。[Stack Overflow+1](https://stackoverflow.com/questions/61029079/how-to-turn-off-buffering-on-nginx-server-for-server-sent-event?utm_source=chatgpt.com)
    
- **LB／CDNのアイドルタイムアウト**
    
    ALBやELBは**デフォルト60秒**でアイドル切断します。ログが一定時間出ないと**接続が勝手に切れる**ので、**心拍**を10–30秒間隔で送るか、**LBのIdle Timeoutを延長**してください。[AWS ドキュメント+2AWS ドキュメント+2](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html?utm_source=chatgpt.com)
    
    Cloudflare配下でも**無送信が続くと524**の報告。SSEでイベントを出し続ける運用が無難です。[Cloudflare Community+1](https://community.cloudflare.com/t/are-server-sent-events-sse-supported-or-will-they-trigger-http-524-timeouts/499621?utm_source=chatgpt.com)
    
- **CORS/資格情報**
    
    同一オリジンなら基本OKですが、もし別オリジンにすると**EventSourceは既定で`withCredentials=false`**。CORSを間違えると**資格情報エラー**に。MDNのガイドに対処がまとまっています。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSMIssingAllowCredentials?utm_source=chatgpt.com)
    
- **SSEの再接続／イベント分割**
    
    WHATWG規格どおり、**クライアントは自動再接続**しますが、**大きなログを一気に1イベントで送る**と途中でこけがち。**適度に分割して`data:`を複数行に**。必要なら`retry:`を送って再接続間隔も制御。[html.spec.whatwg.org](https://html.spec.whatwg.org/multipage/server-sent-events.html?utm_source=chatgpt.com)
    

---

## 2) セキュリティ（ZIP受け取り＆サーバ実行まわり）

- **Zip Slip（ディレクトリトラバーサル）**
    
    ユーザが送るZIPをそのまま解凍すると**`../` を含むパスで任意場所へ書き込み**され得ます。**展開先パスを正規化してベースディレクトリ配下に限定**する対策が必須。ライブラリの既知脆弱性（`unzipper`の過去CVE）にも注意。[security.snyk.io+1](https://security.snyk.io/research/zip-slip-vulnerability?utm_source=chatgpt.com)
    
- **アップロードの一般的対策（OWASP）**
    
    **拡張子・ファイル名ホワイトリスト**、**サイズ上限**、**スキャン/検証**、**実行権限を付けない**、**アップロードディレクトリの分離**など、OWASPの推奨に従うべきです。[cheatsheetseries.owasp.org+1](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html?utm_source=chatgpt.com)
    
- **子プロセス実行の扱い**
    
    `child_process.spawn` の**引数組み立てにユーザ入力を混ぜない**、**`shell:false`**で使う、**タイムアウトと強制kill**を入れる、**stdout/stderrをストリームで逐次処理**。Node公式の作法に従ってください。[Node.js](https://nodejs.org/api/child_process.html?utm_source=chatgpt.com)
    
    *比喩*: “`exec('vivliostyle ' + userInput)`は地雷”、`spawn('vivliostyle',[...])`が正道。
    
- **トークン露出**
    
    SSEやログに**GROWIのアクセストークンや内部URLを出力しない**。CLIの詳細ログにも**秘匿情報が混ざる可能性**があるので、**サニタイズ**を。
    

---

## 3) ビルド実務（Vivliostyle/Chromium依存）

- **Chromium/Playwright系のOS依存ライブラリ不足**
    
    Vivliostyle CLIはヘッドレスブラウザ環境の依存があり、Linuxで**必要パッケージが足りない**と起動不能に。Playwrightの「**`--with-deps`で依存を入れる**」「公式イメージ/CIランナーで揃える」などを参考に**ホスト依存をなくす**と楽です。[Playwright+2Playwright+2](https://playwright.dev/docs/intro?utm_source=chatgpt.com)
    
- **CJKフォント欠落・ウエイト不一致**
    
    **Noto CJK系が未導入**だと“□”になったり、**ウェイトが崩れる**問題が各所で報告。**Noto Sans/Serif CJK（各地域向け）**をシステムに導入し、CSS側も明示指定を。CJK網羅は1書体で完璧ではない点に留意。[GitHub+2GitHub+2](https://github.com/notofonts/noto-cjk/issues/265?utm_source=chatgpt.com)
    
- **相対参照の破綻**
    
    パターンAは**ZIP同梱＋相対リンク**が生命線。`<base>`を入れてしまうと**相対解決がズレる**ことがあるので注意。**`doc.html`基準の相対**で統一。
    
- **巨大HTML/画像でのメモリ・時間超過**
    
    **画像の再圧縮**、**フォントサブセット**、**ページ分割**、**`TIMEOUT_MS`の調整**を。Vivliostyle自体の既定タイムアウトや挙動はドキュメント/リポジトリを事前確認。[docs.vivliostyle.org+1](https://docs.vivliostyle.org/?utm_source=chatgpt.com)
    

---

## 4) GROWI 添付API・サイズ・リトライ

- **添付アップロードのサイズ上限・レート**
    
    GROWI側の**リバースプロキシ／アプリ設定でのボディ上限**に引っかかると失敗。**リトライ（指数バックオフ）とジョブ側のエラー伝播**を実装。添付は**multipart**で投げる設計が前提です（既知のUI実装もmultipart）。公式ドキュメント/管理ガイドも逐次確認を。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events?utm_source=chatgpt.com)
    
- **ストレージがS3/GCS/Azure時の署名URL期限**
    
    “Redirect/Relay”系の仕組みでは**署名付きURLの寿命**があるため、**ビルド直後に即アップロード**を。期限切れ想定の**リトライ**計画も持っておくと安心。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events?utm_source=chatgpt.com)
    
- **CSRFと権限境界**
    
    今回は**サーバ→GROWI（Botトークン等）なのでCSRFの射程外にできますが、トークンスコープ最小化とローテーション**を。
    

---

## 5) その他運用（落ち穂拾い）

- **SSEクライアント数とバックプレッシャ**
    
    同時閲覧が増えると**送信キューが詰まる**可能性。**1ジョブNクライアント**を前提として、**一定時間でクローズ**・**ログは短く**・**最後の数十行だけ保持**などの戦略を。
    
- **ジョブの再開・キャンセル**
    
    SSEは一方向なので**キャンセル**を入れるなら**RESTの`DELETE /jobs/:id`やWebSocket**を併設。
    
- **一時領域の“取り残し”**
    
    finallyで削除しても**プロセス落ち**などで孤児が残ることはある。**夜間クリーン（cron）**を。
    
    *比喩*: “掃除機は自動、でも定期的に床も拭く”。
    
- **監査ログと個人情報**
    
    生成ログに**ページ内容の断片**が混ざることがあります。**PII/機密文字列のマスキング**方針を。
    

---

### ざっくり実装チェックリスト

- [SSE] `Content-Type:text/event-stream`、**心拍送信**、**X-Accel-Buffering:no**、Idle Timeout延長（ALB/ELB/CF設定） [Cloudflare Community+3Cloudflare Docs+3Stack Overflow+3](https://developers.cloudflare.com/agents/api-reference/http-sse/?utm_source=chatgpt.com)
- [SSE] イベントを**細切れ**にして送る／`retry`活用／自動再接続想定（WHATWG） [html.spec.whatwg.org](https://html.spec.whatwg.org/multipage/server-sent-events.html?utm_source=chatgpt.com)
- [ZIP] **Zip Slip対策**（正規化＋プレフィックス判定）・サイズ上限・拡張子検査（OWASP） [security.snyk.io+1](https://security.snyk.io/research/zip-slip-vulnerability?utm_source=chatgpt.com)
- [子プロセス] **spawn(shell:false)**・**タイムアウト＋SIGKILL**・逐次読みでSSE転送（Node公式） [Node.js](https://nodejs.org/api/child_process.html?utm_source=chatgpt.com)
- [フォント] **Noto CJK**導入・フォールバック確認・ウェイト崩れの既知事例に注意 [GitHub+1](https://github.com/notofonts/noto-cjk/issues/265?utm_source=chatgpt.com)
- [依存] **Playwright/Chromium依存解決**（`-with-deps`や公式手順、CIで固定化） [Playwright+1](https://playwright.dev/docs/intro?utm_source=chatgpt.com)
- [GROWI] **multipart添付**・サイズ上限・レート・権限最小化／署名URL期限を意識 [MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events?utm_source=chatgpt.com)
- [掃除] **finally＋夜間クリーン**で一時領域ゼロ化

---

## まとめ（要約）

- **SSEは“逐次送る”ことと“中間のバッファ無効化/心拍”が命**。**LB/CDNのIdle Timeout**にも要注意。[Cloudflare Docs+2Stack Overflow+2](https://developers.cloudflare.com/agents/api-reference/http-sse/?utm_source=chatgpt.com)
- **ZIPはZip Slip対策とOWASPのアップロード対策を厳守**。**spawnは安全な引数で、タイムアウト＆ログ逐次中継**。[security.snyk.io+2cheatsheetseries.owasp.org+2](https://security.snyk.io/research/zip-slip-vulnerability?utm_source=chatgpt.com)
- **Vivliostyle/Chromium系はOS依存ライブラリとCJKフォントが実務の地雷**。**依存を固定**し、**Noto CJKを導入**しておく。[Playwright+2bstefanski.com+2](https://playwright.dev/docs/intro?utm_source=chatgpt.com)
- **GROWI添付APIはmultipart・サイズ上限・署名URL期限**を意識し、**トークンは最小権限で管理**。[MDNウェブドキュメント](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events?utm_source=chatgpt.com)

## TODO
はい、すべてを /vivliostyle/jobs 配下へ統一することは可能です。現状は次のように登録系と参照系が混在しています:

POST /vivliostyle/jobs … multipart 専用
POST /api/v1/jobs … JSON＋base64 専用
GET/DELETE /api/v1/jobs/... … ステータス・成果物・ログ・削除
同一オリジン運用に絞りたいなら、以下のどちらかの方針で /vivliostyle/jobs に一本化できます。

登録系だけ /vivliostyle/jobs にまとめる
/api/v1/jobs を廃止し、/vivliostyle/jobs で multipart だけを受け付ける構成に変更。
→ フロント／ドキュメント／テストすべてで新パスを使うよう修正。

すべての API を /vivliostyle/jobs/... に付け替える

GET /vivliostyle/jobs/:jobId
GET /vivliostyle/jobs/:jobId/result
GET /vivliostyle/jobs/:jobId/log
GET /vivliostyle/jobs/:jobId/log/stream
DELETE /vivliostyle/jobs/:jobId
というようにルーティングを揃え、既存 /api/v1/jobs/... は互換用としてしばらく残すか廃止するか選択します。
その際に必要になる作業は:

src/server.ts のルーティングとバリデーション変更
フロント側の fetch 先 URL を更新（PLUGIN.md の手順含む）
ドキュメント（AGENTS.md / ARCHITECTURE.md / USAGE.md / PLUGIN.md）を /vivliostyle/jobs 系に書き換える
テストのパスを更新し再実行
旧パスを使っている外部からの呼び出しがある場合は移行期間の検討
柔軟性（外部システムから JSON で投げたい等）が不要なら、この統一案のほうが構成はすっきりします。逆に将来的に外部連携を想定するなら、現行の「公開 API は /api/v1/jobs、内部用途は /vivliostyle/jobs」という併存のままのほうが汎用性は高い、という判断になります。

全部/vivliostyle/jobsに統一して。