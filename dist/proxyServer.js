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
    const vivliostyleUrl = new node_url_1.URL(config.vivliostyleTarget);
    const growiUrl = new node_url_1.URL(config.growiTarget);
    // 2 つのプロキシを作成
    const vivliostyleProxy = http_proxy_1.default.createProxyServer({
        target: vivliostyleUrl.href,
        changeOrigin: true,
        ws: true,
        ignorePath: false,
    });
    const growiProxy = http_proxy_1.default.createProxyServer({
        target: growiUrl.href,
        changeOrigin: true,
        ws: true,
        ignorePath: false,
    });
    // カスタムルート用のプロキシ（Keycloak など）
    const customProxies = [];
    if (config.customRoutes?.enabled && config.customRoutes.keycloak?.enabled) {
        const keycloakUrl = new node_url_1.URL(config.customRoutes.keycloak.target);
        const keycloakProxy = http_proxy_1.default.createProxyServer({
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
        logger_1.logger.info("Keycloak routing enabled", {
            path: config.customRoutes.keycloak.path,
            target: keycloakUrl.href,
        });
    }
    const handleProxyError = (error, req, res, targetHref) => {
        logger_1.logger.error("Reverse proxy encountered an error", {
            error: error.message,
            target: targetHref,
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
    };
    vivliostyleProxy.on("error", (error, req, res) => {
        handleProxyError(error, req, res, vivliostyleUrl.href);
    });
    growiProxy.on("error", (error, req, res) => {
        handleProxyError(error, req, res, growiUrl.href);
    });
    const server = node_http_1.default.createServer((req, res) => {
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
        }
        else {
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
        }
        else {
            growiProxy.ws(req, socket, head);
        }
    });
    return server;
};
exports.createReverseProxyServer = createReverseProxyServer;
if (require.main === module) {
    const vivliostyleTarget = process.env.VIV_PROXY_TARGET ?? "http://127.0.0.1:4781";
    const growiTarget = process.env.GROWI_TARGET ?? "http://127.0.0.1:3000";
    const port = Number.parseInt(process.env.VIV_PROXY_PORT ?? "4871", 10);
    const hostname = process.env.VIV_PROXY_HOST ?? "0.0.0.0";
    const customRoutingEnabled = process.env.VIV_CUSTOM_ROUTING_ENABLED === "true";
    const keycloakEnabled = process.env.VIV_KEYCLOAK_ROUTING_ENABLED === "true";
    const server = (0, exports.createReverseProxyServer)({
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
        const address = server.address();
        logger_1.logger.info("Reverse proxy listening", {
            vivliostyleTarget,
            growiTarget,
            port: address.port,
            hostname: address.address,
            customRoutingEnabled,
            keycloakEnabled: customRoutingEnabled && keycloakEnabled,
        });
    });
}
//# sourceMappingURL=proxyServer.js.map