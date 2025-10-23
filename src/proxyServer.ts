import http, { ServerResponse } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { URL } from "node:url";

import httpProxy from "http-proxy";

import { logger } from "./logger";

export interface CustomRoute {
  enabled: boolean;
  target: string;
  path: string;
}

export interface ReverseProxyConfig {
  vivliostyleTarget: string; // CLI サーバのターゲット
  growiTarget: string;       // GROWI のターゲット
  port: number;
  hostname?: string;
  customRoutes?: {
    enabled: boolean;
    keycloak?: CustomRoute;
  };
}

export const createReverseProxyServer = (config: ReverseProxyConfig) => {
  const vivliostyleUrl = new URL(config.vivliostyleTarget);
  const growiUrl = new URL(config.growiTarget);

  // 2 つのプロキシを作成
  const vivliostyleProxy = httpProxy.createProxyServer({
    target: vivliostyleUrl.href,
    changeOrigin: true,
    ws: true,
    ignorePath: false,
  });

  const growiProxy = httpProxy.createProxyServer({
    target: growiUrl.href,
    changeOrigin: true,
    ws: true,
    ignorePath: false,
  });

  // カスタムルート用のプロキシ（Keycloak など）
  const customProxies: Array<{ path: string; proxy: httpProxy; target: string }> = [];
  
  if (config.customRoutes?.enabled && config.customRoutes.keycloak?.enabled) {
    const keycloakUrl = new URL(config.customRoutes.keycloak.target);
    const keycloakProxy = httpProxy.createProxyServer({
      target: keycloakUrl.href,
      changeOrigin: true,
      ws: true,
      ignorePath: false,
    });
    
    customProxies.push({
      path: config.customRoutes.keycloak.path,
      proxy: keycloakProxy,
      target: keycloakUrl.href,
    });

    keycloakProxy.on("error", (error, req, res) => {
      handleProxyError(error, req, res, keycloakUrl.href);
    });

    logger.info("Keycloak routing enabled", {
      path: config.customRoutes.keycloak.path,
      target: keycloakUrl.href,
    });
  }

  const handleProxyError = (error: Error, req: http.IncomingMessage, res: http.ServerResponse | Socket, targetHref: string) => {
    logger.error("Reverse proxy encountered an error", {
      error: error.message,
      target: targetHref,
      url: req?.url,
    });
    if (!res) {
      return;
    }
    if (res instanceof ServerResponse) {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
      }
      res.end("Bad Gateway");
    } else if (res instanceof Socket) {
      res.destroy(error);
    }
  };

  vivliostyleProxy.on("error", (error, req, res) => {
    handleProxyError(error, req, res, vivliostyleUrl.href);
  });

  growiProxy.on("error", (error, req, res) => {
    handleProxyError(error, req, res, growiUrl.href);
  });

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    
    // カスタムルートのチェック（優先度高）
    for (const customRoute of customProxies) {
      if (url.startsWith(customRoute.path)) {
        customRoute.proxy.web(req, res);
        return;
      }
    }
    
    // /vivliostyle で始まる場合は CLI サーバへ、それ以外は GROWI へ
    if (url.startsWith("/vivliostyle")) {
      vivliostyleProxy.web(req, res);
    } else {
      growiProxy.web(req, res);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
    
    // カスタムルートのチェック（WebSocket）
    for (const customRoute of customProxies) {
      if (url.startsWith(customRoute.path)) {
        customRoute.proxy.ws(req, socket, head);
        return;
      }
    }
    
    // WebSocket も同様に振り分け
    if (url.startsWith("/vivliostyle")) {
      vivliostyleProxy.ws(req, socket, head);
    } else {
      growiProxy.ws(req, socket, head);
    }
  });

  return server;
};

if (require.main === module) {
  const vivliostyleTarget = process.env.VIV_PROXY_TARGET ?? "http://127.0.0.1:4781";
  const growiTarget = process.env.GROWI_TARGET ?? "http://127.0.0.1:3000";
  const port = Number.parseInt(process.env.VIV_PROXY_PORT ?? "4871", 10);
  const hostname = process.env.VIV_PROXY_HOST ?? "0.0.0.0";

  const customRoutingEnabled = process.env.VIV_CUSTOM_ROUTING_ENABLED === "true";
  const keycloakEnabled = process.env.VIV_KEYCLOAK_ROUTING_ENABLED === "true";
  
  const server = createReverseProxyServer({
    vivliostyleTarget,
    growiTarget,
    port,
    hostname,
    customRoutes: customRoutingEnabled ? {
      enabled: true,
      keycloak: keycloakEnabled ? {
        enabled: true,
        target: process.env.VIV_KEYCLOAK_TARGET ?? "http://127.0.0.1:8080",
        path: process.env.VIV_KEYCLOAK_PATH ?? "/auth",
      } : undefined,
    } : undefined,
  });

  server.listen(port, hostname, () => {
    const address = server.address() as AddressInfo;
    logger.info("Reverse proxy listening", {
      vivliostyleTarget,
      growiTarget,
      port: address.port,
      hostname: address.address,
      customRoutingEnabled,
      keycloakEnabled: customRoutingEnabled && keycloakEnabled,
    });
  });
}
