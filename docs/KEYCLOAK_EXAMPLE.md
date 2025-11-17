# Keycloak ルーティング使用例

## シナリオ

GROWI に Keycloak 認証を統合し、すべてを同一オリジン配下で動作させる。

## 構成

```
https://wiki.example.com/          → GROWI
https://wiki.example.com/auth/     → Keycloak
https://wiki.example.com/vivliostyle/ → Vivliostyle CLI
```

## セットアップ手順

### 1. Keycloak のセットアップ

Docker Compose で Keycloak を起動：

```yaml
# docker-compose.yml
version: '3.8'

services:
  keycloak:
    image: quay.io/keycloak/keycloak:23.0
    command: start-dev
    environment:
      - KEYCLOAK_ADMIN=admin
      - KEYCLOAK_ADMIN_PASSWORD=admin
      - KC_PROXY=edge
      - KC_HOSTNAME_STRICT=false
    ports:
      - "8080:8080"
    volumes:
      - keycloak_data:/opt/keycloak/data

volumes:
  keycloak_data:
```

起動：

```bash
docker-compose up -d keycloak
```

### 2. リバースプロキシの設定

`.env` ファイルを作成：

```env
# リバースプロキシ設定
VIV_PROXY_PORT=4871
VIV_PROXY_HOST=0.0.0.0

# GROWI と Vivliostyle のターゲット
GROWI_TARGET=http://127.0.0.1:3000
VIV_PROXY_TARGET=http://127.0.0.1:4781

# カスタムルーティング: Keycloak
VIV_CUSTOM_ROUTING_ENABLED=true
VIV_KEYCLOAK_ROUTING_ENABLED=true
VIV_KEYCLOAK_TARGET=http://127.0.0.1:8080
VIV_KEYCLOAK_PATH=/auth
```

### 3. サーバの起動

```bash
# Vivliostyle サーバ（ジョブ処理）
npm run dev

# 別ターミナルで リバースプロキシ
npm run proxy
```

または PM2 で一括起動：

```bash
npm run pm2:start
```

### 4. 動作確認

#### Keycloak の管理画面にアクセス

```bash
# リバースプロキシ経由
open http://localhost:4871/auth/admin/

# 直接アクセス（比較用）
open http://localhost:8080/admin/
```

ログイン：
- ユーザー名: `admin`
- パスワード: `admin`

#### GROWI にアクセス

```bash
open http://localhost:4871/
```

#### Vivliostyle ジョブ API にアクセス

```bash
# ヘルスチェック（実装されている場合）
curl http://localhost:4871/vivliostyle/health
```

## GROWI と Keycloak の統合

### Keycloak でレルムとクライアントを作成

1. Keycloak 管理画面 (`http://localhost:4871/auth/admin/`) にログイン
2. 新しいレルムを作成（例: `growi`）
3. クライアントを作成：
   - Client ID: `growi-client`
   - Root URL: `http://localhost:4871`
   - Valid redirect URIs: `http://localhost:4871/*`
   - Web origins: `http://localhost:4871`

### GROWI の環境変数設定

GROWI 側で Keycloak を OIDC プロバイダとして設定：

```env
# GROWI の .env
OAUTH_KEYCLOAK_ENABLED=true
OAUTH_KEYCLOAK_ISSUER=http://localhost:4871/auth/realms/growi
OAUTH_KEYCLOAK_CLIENT_ID=growi-client
OAUTH_KEYCLOAK_CLIENT_SECRET=<client-secret>
OAUTH_KEYCLOAK_AUTHORIZATION_URL=http://localhost:4871/auth/realms/growi/protocol/openid-connect/auth
OAUTH_KEYCLOAK_TOKEN_URL=http://localhost:4871/auth/realms/growi/protocol/openid-connect/token
OAUTH_KEYCLOAK_USER_INFO_URL=http://localhost:4871/auth/realms/growi/protocol/openid-connect/userinfo
```

## 本番環境での設定

### Nginx の設定例

```nginx
server {
    listen 443 ssl http2;
    server_name wiki.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:4871;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket サポート
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # SSE サポート
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

### Docker Compose での統合構成

```yaml
version: '3.8'

services:
  # リバースプロキシ（統合サーバ）
  reverse-proxy:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "4871:4871"
    environment:
      - NODE_ENV=production
      - VIV_CUSTOM_ROUTING_ENABLED=true
      - VIV_KEYCLOAK_ROUTING_ENABLED=true
      - VIV_KEYCLOAK_TARGET=http://keycloak:8080
      - VIV_KEYCLOAK_PATH=/auth
      - VIV_PROXY_TARGET=http://vivliostyle:4781
      - GROWI_TARGET=http://growi:3000
      - VIV_PROXY_PORT=4871
      - VIV_PROXY_HOST=0.0.0.0
    depends_on:
      - growi
      - keycloak
      - vivliostyle
    volumes:
      - vivliostyle_jobs:/app/jobs
    networks:
      - growi_network

  # GROWI
  growi:
    image: weseek/growi:6
    ports:
      - "3000:3000"
    environment:
      - MONGO_URI=mongodb://mongo:27017/growi
      - ELASTICSEARCH_URI=http://elasticsearch:9200/growi
      - OAUTH_KEYCLOAK_ENABLED=true
      - OAUTH_KEYCLOAK_ISSUER=http://reverse-proxy:4871/auth/realms/growi
      - OAUTH_KEYCLOAK_CLIENT_ID=growi-client
      - OAUTH_KEYCLOAK_CLIENT_SECRET=${KEYCLOAK_CLIENT_SECRET}
    depends_on:
      - mongo
      - elasticsearch
    volumes:
      - growi_data:/data
    networks:
      - growi_network

  # Vivliostyle CLI Server
  vivliostyle:
    build:
      context: .
      dockerfile: Dockerfile
    command: npm start
    environment:
      - NODE_ENV=production
      - PORT=4781
    volumes:
      - vivliostyle_jobs:/app/jobs
    networks:
      - growi_network

  # Keycloak
  keycloak:
    image: quay.io/keycloak/keycloak:23.0
    command: start --proxy edge
    environment:
      - KEYCLOAK_ADMIN=admin
      - KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}
      - KC_PROXY=edge
      - KC_HOSTNAME_STRICT=false
      - KC_HOSTNAME=wiki.example.com
      - KC_HTTP_ENABLED=true
    ports:
      - "8080:8080"
    volumes:
      - keycloak_data:/opt/keycloak/data
    networks:
      - growi_network

  # MongoDB
  mongo:
    image: mongo:6
    volumes:
      - mongo_data:/data/db
    networks:
      - growi_network

  # Elasticsearch
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
    environment:
      - discovery.type=single-node
      - xpack.security.enabled=false
    volumes:
      - es_data:/usr/share/elasticsearch/data
    networks:
      - growi_network

volumes:
  growi_data:
  vivliostyle_jobs:
  keycloak_data:
  mongo_data:
  es_data:

networks:
  growi_network:
```

起動：

```bash
docker-compose up -d
```

## トラブルシューティング

### Keycloak にアクセスできない

ログを確認：

```bash
docker-compose logs reverse-proxy | grep -i keycloak
```

期待される出力：

```
Keycloak routing enabled { path: '/auth', target: 'http://keycloak:8080/' }
```

### GROWI から Keycloak 認証ができない

1. Keycloak のクライアント設定を確認
2. リダイレクト URI が正しいか確認
3. クライアントシークレットが正しいか確認

### リバースプロキシのデバッグ

```bash
# プロキシのログを確認
npm run proxy 2>&1 | tee proxy.log

# 各エンドポイントへのアクセスをテスト
curl -v http://localhost:4871/
curl -v http://localhost:4871/auth/
curl -v http://localhost:4871/vivliostyle/jobs
```

## まとめ

この設定により：

✅ すべてのサービスが同一オリジン配下に統合される  
✅ CORS の問題が発生しない  
✅ Keycloak による統一認証が可能  
✅ 証明書の管理が一元化される  
✅ リバースプロキシが一箇所で管理できる  
