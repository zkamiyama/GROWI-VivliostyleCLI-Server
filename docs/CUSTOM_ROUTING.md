# カスタムルーティング設定ガイド

## 概要

このサーバは、GROWI と Vivliostyle CLI サーバへのリバースプロキシ機能に加えて、
カスタムルーティング機能を提供します。これにより、Keycloak などの追加サービスを
同一オリジン配下に統合できます。

## 設定方法

### 環境変数

カスタムルーティング機能は環境変数で制御します。

#### 基本設定

- `VIV_CUSTOM_ROUTING_ENABLED`: カスタムルーティング全体の ON/OFF
  - `true`: 有効
  - `false` または未設定: 無効（デフォルト）

#### Keycloak ルーティング

- `VIV_KEYCLOAK_ROUTING_ENABLED`: Keycloak ルーティングの ON/OFF
  - `true`: 有効
  - `false` または未設定: 無効（デフォルト）

- `VIV_KEYCLOAK_TARGET`: Keycloak サーバのターゲット URL
  - デフォルト: `http://127.0.0.1:8080`
  - 例: `http://keycloak:8080`

- `VIV_KEYCLOAK_PATH`: Keycloak へルーティングするパス
  - デフォルト: `/auth`
  - このパスで始まるリクエストが Keycloak へプロキシされます

### 設定例

#### 例1: Keycloak を有効化（デフォルト設定）

```bash
# .env または環境変数
VIV_CUSTOM_ROUTING_ENABLED=true
VIV_KEYCLOAK_ROUTING_ENABLED=true
VIV_KEYCLOAK_TARGET=http://127.0.0.1:8080
VIV_KEYCLOAK_PATH=/auth
```

この設定では、以下のようにルーティングされます：

- `https://wiki.example.com/auth/*` → Keycloak (`http://127.0.0.1:8080/auth/*`)
- `https://wiki.example.com/vivliostyle/*` → Vivliostyle CLI サーバ
- `https://wiki.example.com/*` → GROWI

#### 例2: Docker Compose での設定

```yaml
services:
  reverse-proxy:
    environment:
      - VIV_CUSTOM_ROUTING_ENABLED=true
      - VIV_KEYCLOAK_ROUTING_ENABLED=true
      - VIV_KEYCLOAK_TARGET=http://keycloak:8080
      - VIV_KEYCLOAK_PATH=/auth
      - VIV_PROXY_TARGET=http://vivliostyle-server:4781
      - GROWI_TARGET=http://growi:3000
      - VIV_PROXY_PORT=4871

  keycloak:
    image: quay.io/keycloak/keycloak:latest
    ports:
      - "8080:8080"
    environment:
      - KEYCLOAK_ADMIN=admin
      - KEYCLOAK_ADMIN_PASSWORD=admin
```

#### 例3: カスタムルーティングを無効化

```bash
# カスタムルーティングを使わない場合は、環境変数を設定しない
# または明示的に無効化
VIV_CUSTOM_ROUTING_ENABLED=false
```

## ルーティング優先順位

リクエストは以下の優先順位で振り分けられます：

1. **カスタムルート**（Keycloak など）
   - 例: `/auth/*`
2. **Vivliostyle CLI サーバ**
   - `/vivliostyle/*`
3. **GROWI**（デフォルト）
   - 上記以外のすべてのパス

## 注意事項

### 同一オリジンポリシー

すべてのサービスが同一オリジン（スキーム＋ホスト＋ポート）配下に配置されるため、
CORS の問題を回避できます。

### WebSocket 対応

カスタムルートも WebSocket の upgrade リクエストに対応しています。

### パスの競合

カスタムルートのパスが他のルートと競合しないように注意してください。
特に、以下のパスは予約済みです：

- `/vivliostyle/*`: Vivliostyle CLI サーバ
- GROWI が使用するパス（プラグインやAPIパスなど）

### セキュリティ

- Keycloak などの認証サーバは適切に設定してください
- 本番環境では HTTPS を使用してください
- アクセストークンなどの機密情報が漏洩しないように注意してください

## トラブルシューティング

### Keycloak に接続できない

1. `VIV_KEYCLOAK_TARGET` が正しいか確認
2. Keycloak サーバが起動しているか確認
3. ネットワーク接続を確認（Docker の場合はサービス名の名前解決）
4. ログを確認：
   ```bash
   # ログで "Keycloak routing enabled" が出力されているか確認
   ```

### ルーティングが動作しない

1. `VIV_CUSTOM_ROUTING_ENABLED=true` が設定されているか確認
2. `VIV_KEYCLOAK_ROUTING_ENABLED=true` が設定されているか確認
3. サーバを再起動
4. ログレベルを上げて詳細を確認

## 今後の拡張

この機能は拡張可能な設計になっています。将来的には、以下のような
カスタムルートを追加できます：

- MinIO（オブジェクトストレージ）
- Elasticsearch（検索エンジン）
- その他の認証プロバイダ

設定方法は同様のパターンで追加できます。
