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
        VIV_PROXY_PORT: process.env.VIV_PROXY_PORT || 4871
      }
    }
  ]
};
