module.exports = {
  apps: [
    {
      name: 'vivliostyle-cli-server',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '2048M',
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 4781,
        VIV_WORKSPACE_DIR: process.env.VIV_WORKSPACE_DIR || './jobs'
      }
    },
    {
      name: 'vivliostyle-proxy',
      script: 'dist/proxyServer.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
        VIV_PROXY_TARGET: process.env.VIV_PROXY_TARGET || 'http://127.0.0.1:4781',
        GROWI_TARGET: process.env.GROWI_TARGET || 'http://127.0.0.1:3000',
        VIV_PROXY_PORT: process.env.VIV_PROXY_PORT || 4871,
        VIV_PROXY_HOST: process.env.VIV_PROXY_HOST || '0.0.0.0',
        // カスタムルーティング設定（Keycloak など）
        VIV_CUSTOM_ROUTING_ENABLED: process.env.VIV_CUSTOM_ROUTING_ENABLED || 'true',
        VIV_KEYCLOAK_ROUTING_ENABLED: process.env.VIV_KEYCLOAK_ROUTING_ENABLED || 'true',
        VIV_KEYCLOAK_TARGET: process.env.VIV_KEYCLOAK_TARGET || 'http://127.0.0.1:8080',
        VIV_KEYCLOAK_PATH: process.env.VIV_KEYCLOAK_PATH || '/auth'
      }
    }
  ]
};
