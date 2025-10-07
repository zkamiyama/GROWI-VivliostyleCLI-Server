"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReverseProxyServer = void 0;
const node_http_1 = __importStar(require("node:http"));
const node_net_1 = require("node:net");
const node_url_1 = require("node:url");
const http_proxy_1 = __importDefault(require("http-proxy"));
const logger_1 = require("./logger");
const createReverseProxyServer = (config) => {
    const targetUrl = new node_url_1.URL(config.target);
    const proxy = http_proxy_1.default.createProxyServer({
        target: targetUrl.href,
        changeOrigin: true,
        ws: true,
        ignorePath: false,
    });
    proxy.on("error", (error, req, res) => {
        logger_1.logger.error("Reverse proxy encountered an error", {
            error: error.message,
            target: targetUrl.href,
            url: req?.url,
        });
        if (!res) {
            return;
        }
        if (res instanceof node_http_1.ServerResponse) {
            if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "text/plain" });
            }
            res.end("Bad Gateway");
        }
        else if (res instanceof node_net_1.Socket) {
            res.destroy(error);
        }
    });
    const server = node_http_1.default.createServer((req, res) => {
        proxy.web(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
        proxy.ws(req, socket, head);
    });
    return server;
};
exports.createReverseProxyServer = createReverseProxyServer;
if (require.main === module) {
    const target = process.env.VIV_PROXY_TARGET ?? "http://127.0.0.1:4781";
    const port = Number.parseInt(process.env.VIV_PROXY_PORT ?? "4871", 10);
    const hostname = process.env.VIV_PROXY_HOST ?? "0.0.0.0";
    const server = (0, exports.createReverseProxyServer)({
        target,
        port,
        hostname,
    });
    server.listen(port, hostname, () => {
        const address = server.address();
        logger_1.logger.info("Reverse proxy listening", {
            target,
            port: address.port,
            hostname: address.address,
        });
    });
}
//# sourceMappingURL=proxyServer.js.map