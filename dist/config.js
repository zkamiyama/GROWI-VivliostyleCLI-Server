"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_PORT = 4781;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_ARCHIVE_MB = 500;
const DEFAULT_CLI_TIMEOUT_MS = 600_000;
const DEFAULT_AUTOCLEANUP_TIMEOUT_MS = 900_000;
const DEFAULT_FRONTEND_PING_TIMEOUT_MS = 3_000;
const numberFromEnv = (value, fallback) => {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const numberFromEnvAllowZero = (value, fallback) => {
    if (value === undefined) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
exports.config = {
    port: numberFromEnv(process.env.PORT, DEFAULT_PORT),
    concurrency: numberFromEnv(process.env.VIV_QUEUE_CONCURRENCY, DEFAULT_CONCURRENCY),
    workspaceDir: node_path_1.default.resolve(process.env.VIV_WORKSPACE_DIR ?? node_path_1.default.join(process.cwd(), "jobs")),
    maxArchiveBytes: numberFromEnv(process.env.VIV_MAX_ARCHIVE_SIZE_MB, DEFAULT_MAX_ARCHIVE_MB) *
        1024 *
        1024,
    cliTimeoutMs: numberFromEnv(process.env.VIV_CLI_TIMEOUT_MS, DEFAULT_CLI_TIMEOUT_MS),
    autoCleanupTimeoutMs: numberFromEnvAllowZero(process.env.VIV_AUTOCLEANUP_TIMEOUT_MS, DEFAULT_AUTOCLEANUP_TIMEOUT_MS),
    frontendPingUrl: process.env.VIV_FRONTEND_PING_URL ?? "",
    frontendPingTimeoutMs: numberFromEnvAllowZero(process.env.VIV_FRONTEND_PING_TIMEOUT_MS, DEFAULT_FRONTEND_PING_TIMEOUT_MS),
    // カスタムルーティング設定
    customRouting: {
        enabled: process.env.VIV_CUSTOM_ROUTING_ENABLED === "true",
        keycloak: {
            enabled: process.env.VIV_KEYCLOAK_ROUTING_ENABLED === "true",
            target: process.env.VIV_KEYCLOAK_TARGET ?? "http://127.0.0.1:8080",
            path: process.env.VIV_KEYCLOAK_PATH ?? "/auth",
        },
    },
};
//# sourceMappingURL=config.js.map