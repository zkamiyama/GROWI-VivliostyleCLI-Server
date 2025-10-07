# GROWI Vivliostyle プラグイン実装ガイド

このドキュメントは GROWI 側プラグインから本サーバー API を利用するための実装指針です。

## 1. エンドポイント一覧
| メソッド | パス | 用途 |
| --- | --- | --- |
| POST | /vivliostyle/jobs | 同一オリジン向けの multipart/form-data 受付 |
| POST | /api/v1/jobs | JSON + base64 受付。クロスオリジンで利用する場合はこちら |
| GET | /api/v1/jobs/:jobId | ジョブの状態・成果物リストを取得 |
| GET | /api/v1/jobs/:jobId/log/stream | SSE でログ・ステータスをリアルタイム受信 |
| GET | /api/v1/jobs/:jobId/result | 成果物（PDF など）をダウンロード |
| DELETE | /api/v1/jobs/:jobId | ジョブディレクトリの削除 |

## 2. 推奨ワークフロー
1. **ZIP アーカイブ作成**
   - 対象ページの HTML/Markdown、ivliostyle.config.js、CSS、画像などをまとめて ZIP。
   - 不要ファイル（node_modules など）は除去し、500 MB の制限内に抑える。
2. **ジョブ登録**（同一オリジンの場合）
   `	s
   const form = new FormData();
   form.append("pageId", pageId);      // 例: "page:123"
   form.append("pagePath", pagePath);  // GROWI のパス
   form.append("title", title);
   form.append("zip", fileBlob, "project.zip");

   const res = await fetch("/vivliostyle/jobs", {
     method: "POST",
     body: form,
   });
   const { jobId } = await res.json();
   `
   - JSON で送信する場合は /api/v1/jobs に sourceArchive を base64 文字列で設定。
3. **進捗監視**
   - SSE を利用してログとステータスを受信する。
   `	s
   const source = new EventSource(/api/v1/jobs//log/stream);

   source.onmessage = (event) => {
     const payload = JSON.parse(event.data);
     appendLog(payload);
   };

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
   `
   - SSE が使えない環境では GET /api/v1/jobs/:jobId を数秒おきにポーリング。
4. **成果物ダウンロード**
   `	s
   const res = await fetch(/api/v1/jobs//result);
   const blob = await res.blob();
   await uploadToAttachment(blob, ${title}.pdf);
   `
   - 追加ファイルが必要な場合は ?file=relative/path を付与。
5. **クリーンアップ**
   - ATTACHMENT への保存が完了したら DELETE /api/v1/jobs/:jobId を呼び出し、サーバー上のジョブディレクトリを削除。

## 3. エラー処理
- API が 400 を返す場合は入力不備。ユーザー向けにメッセージを表示。
- 409 はジョブ ID の重複またはジョブが進行中。ID を変えるか完了を待つ。
- SSE で status: failed を受け取ったら、complete イベントに含まれる eason / message を確認し、UI に表示。

## 4. 逆プロキシ越しの利用
- GROWI と同じオリジンで扱いたい場合は 
pm run proxy で起動するプロキシを経由させる。
- SSE を通すため、プロキシでは HTTP/1.1 を維持し、X-Accel-Buffering: no や Cache-Control: no-cache を設定する。

## 5. チェックリスト
- [ ] ZIP に不要ファイルを含めない
- [ ] 500MB 超過時に警告を出す
- [ ] SSE 非対応環境向けにポーリングをフォールバック
- [ ] 成果物保存後に DELETE を必ず実行
- [ ] 失敗時に job.json.error を UI に表示

本ガイドに従うことで、Vivliostyle サーバーと GROWI プラグインを安全かつ効率的に連携できます。

