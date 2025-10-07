import http, { ServerResponse } from "node:http";
import { AddressInfo, Socket } from "node:net";
import { URL } from "node:url";

import httpProxy from "http-proxy";

import { logger } from "./logger";

export interface ReverseProxyConfig {
  target: string;
  port: number;
  hostname?: string;
}

export const createReverseProxyServer = (config: ReverseProxyConfig) => {
  const targetUrl = new URL(config.target);
  const proxy = httpProxy.createProxyServer({
    target: targetUrl.href,
    changeOrigin: true,
    ws: true,
    ignorePath: false,
  });

  proxy.on("error", (error, req, res) => {
    logger.error("Reverse proxy encountered an error", {
      error: error.message,
      target: targetUrl.href,
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
  });

  const server = http.createServer((req, res) => {
    proxy.web(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    proxy.ws(req, socket, head);
  });

  return server;
};

if (require.main === module) {
  const target = process.env.VIV_PROXY_TARGET ?? "http://127.0.0.1:4781";
  const port = Number.parseInt(process.env.VIV_PROXY_PORT ?? "4871", 10);
  const hostname = process.env.VIV_PROXY_HOST ?? "0.0.0.0";

  const server = createReverseProxyServer({
    target,
    port,
    hostname,
  });

  server.listen(port, hostname, () => {
    const address = server.address() as AddressInfo;
    logger.info("Reverse proxy listening", {
      target,
      port: address.port,
      hostname: address.address,
    });
  });
}
