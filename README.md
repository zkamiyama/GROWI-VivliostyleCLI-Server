# GROWI-VivliostyleCLI-Server

このリポジトリは、GROWI プラグインから Vivliostyle CLI を使って PDF を生成するための小さなジョブサーバです。

- ZIP で渡された HTML/アセットを展開
- Vivliostyle CLI で PDF を生成
- 生成した PDF を GROWI の添付 API にアップロード
- ジョブの進捗は SSE やポーリングで取得可能
