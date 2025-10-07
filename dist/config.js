"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_PORT = 4781;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_ARCHIVE_MB = 50;
const DEFAULT_CLI_TIMEOUT_MS = 600_000;
const numberFromEnv = (value, fallback) => {
    if (!value) {
        return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
exports.config = {
    port: numberFromEnv(process.env.PORT, DEFAULT_PORT),
    concurrency: numberFromEnv(process.env.VIV_QUEUE_CONCURRENCY, DEFAULT_CONCURRENCY),
    workspaceDir: node_path_1.default.resolve(process.env.VIV_WORKSPACE_DIR ?? node_path_1.default.join(process.cwd(), "jobs")),
    maxArchiveBytes: numberFromEnv(process.env.VIV_MAX_ARCHIVE_SIZE_MB, DEFAULT_MAX_ARCHIVE_MB) *
        1024 *
        1024,
    cliTimeoutMs: numberFromEnv(process.env.VIV_CLI_TIMEOUT_MS, DEFAULT_CLI_TIMEOUT_MS),
};
//# sourceMappingURL=config.js.map