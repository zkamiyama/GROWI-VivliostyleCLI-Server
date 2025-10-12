import http, { ServerResponse } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { URL } from "node:url";

import httpProxy from "http-proxy";

import { logger } from "./logger";

export interface ReverseProxyConfig {
  vivliostyleTarget: string; // CLI サーバのターゲット
  growiTarget: string;       // GROWI のターゲット
  port: number;
  hostname?: string;
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
    // /vivliostyle で始まる場合は CLI サーバへ、それ以外は GROWI へ
    if (url.startsWith("/vivliostyle")) {
      vivliostyleProxy.web(req, res);
    } else {
      growiProxy.web(req, res);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
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

  const server = createReverseProxyServer({
    vivliostyleTarget,
    growiTarget,
    port,
    hostname,
  });

  server.listen(port, hostname, () => {
    const address = server.address() as AddressInfo;
    logger.info("Reverse proxy listening", {
      vivliostyleTarget,
      growiTarget,
      port: address.port,
      hostname: address.address,
    });
  });
}
