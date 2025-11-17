# GROWI Vivliostyle プラグインガイド

このドキュメントは、GROWI 側プラグインから本サーバーの API を利用して Vivliostyle CLI ジョブを実行する際の手順と注意点をまとめたものです。

## 1. エンドポイント一覧
| メソッド | パス | 用途 |
| --- | --- | --- |
| POST | /vivliostyle/jobs | application/json（sourceArchive を base64 で送信）または multipart/form-data（pageId/pagePath/title/zip）を受理 |
| GET | /vivliostyle/jobs/:jobId | ジョブの状態・成果物リスト・ログ末尾・キュー情報を取得 |
| GET | /vivliostyle/jobs/:jobId/log/stream | SSE でログとステータス更新をリアルタイム受信 |
| GET | /vivliostyle/jobs/:jobId/result | 成果物（PDF など）をダウンロード。`?file=` で相対パス指定可 |
| DELETE | /vivliostyle/jobs/:jobId | ジョブディレクトリを削除（進行中は 409 を返却） |

## 2. 推奨ワークフロー
1. **ZIP アーカイブ作成**
   - 対象ページの HTML/Markdown、vivliostyle.config.js、CSS、画像・フォントなどをまとめて ZIP 化。
   - 不要なファイル（`node_modules` など）は除去し、500 MB の上限内に収める。
2. **ジョブ登録（同一オリジン例）**
   ```ts
   const form = new FormData();
   form.append("pageId", pageId);      // 例: "page:123"
   form.append("pagePath", pagePath);  // GROWI 上のパス
   form.append("title", title);
   form.append("zip", fileBlob, "project.zip");

   const res = await fetch("/vivliostyle/jobs", {
     method: "POST",
     body: form,
   });
   const { jobId } = await res.json();
   ```
   - application/json で送信する場合は `sourceArchive` に base64 文字列を設定する。
3. **進捗監視**
   - SSE を用いてログとステータスをリアルタイムに受信。
   ```ts
   const source = new EventSource(`/vivliostyle/jobs/${jobId}/log/stream`);

      source.addEventListener("jobs", (event) => {
     const payload = JSON.parse(event.data);
     appendLog(payload); // payload.message は常に "[jobs] ..." 形式
   });
   });

   source.addEventListener("status", (event) => {
     const { status } = JSON.parse(event.data);
     updateStatus(status); // queued / running / succeeded / failed
   });

   source.addEventListener("complete", (event) => {
     source.close();
     const meta = JSON.parse(event.data);
     if (meta.status === "succeeded") {
       downloadResult(jobId);
     } else {
       showError(meta);
     }
   });
   ```
   - SSE は `event: jobs`（ログ）と `event: status`（状態更新）で届きます。対応していない環境では `GET /vivliostyle/jobs/:jobId` を数秒おきにポーリングする。
   - ログの `message` は `[jobs]` プレフィックス付きで送信されるため、UI でそのまま表示すると区別しやすくなります。
4. **成果物ダウンロード**
   ```ts
   const res = await fetch(`/vivliostyle/jobs/${jobId}/result`);
   const blob = await res.blob();
   await uploadToAttachment(blob, `${title}.pdf`);
   ```
   - 追加ファイルが必要な場合は `?file=relative/path` を付与して取得する。
5. **クリーンアップ**
   - ATTACHMENT への保存が完了したら `DELETE /vivliostyle/jobs/:jobId` を呼び、サーバー上のジョブディレクトリを削除する（一定時間後には自動削除されるが、明示的なクリーンアップを推奨）。

## 3. エラー処理
- 400 系は入力不備。詳細メッセージを利用者に表示して再送を促す。
- 409 はジョブ ID の重複またはジョブが進行中。ID を変更するか完了を待つ。
- SSE で `status: failed` を受け取った場合は `complete` イベントの `reason` / `message` を確認し、UI に表示する。

## 4. プロキシ越しの利用
- GROWI と同一オリジンで扱いたい場合は `npm run proxy` で提供されるリバースプロキシを経由させる。
- SSE を通すため、プロキシでは HTTP/1.1 を維持し、`X-Accel-Buffering: no` と `Cache-Control: no-cache` を設定する。

## 5. チェックリスト
- [ ] ZIP に不要ファイルを含めていないか
- [ ] 500 MB 超過時に警告を表示できるか
- [ ] SSE 非対応環境向けのポーリング fallback があるか
- [ ] 成果物保存後に DELETE を確実に実行しているか
- [ ] 失敗時に `job.json.error` の内容を UI に表示しているか

このガイドに従うことで、Vivliostyle サーバーと GROWI プラグインを安全かつ効率的に連携できます。


