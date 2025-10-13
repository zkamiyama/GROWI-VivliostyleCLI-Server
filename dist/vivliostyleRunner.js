"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runVivliostyle = void 0;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:timers/promises");
const config_1 = require("./config");
const logger_1 = require("./logger");
const CLI_BIN = resolveCliBinary();
const buildArguments = (opts) => {
    const args = ["build"];
    if (opts.configPath) {
        args.push("--config", opts.configPath);
    }
    if (opts.outputFile) {
        args.push("--output", opts.outputFile);
    }
    if (opts.format) {
        args.push("--format", opts.format);
    }
    if (opts.timeoutSeconds && Number.isFinite(opts.timeoutSeconds)) {
        args.push("--timeout", String(opts.timeoutSeconds));
    }
    if (opts.additionalArgs?.length) {
        args.push(...opts.additionalArgs);
    }
    if (typeof opts.css === "string" && opts.css.length > 0) {
        args.push("--css", opts.css);
    }
    const entries = Array.isArray(opts.entry) ? opts.entry : (opts.entry ? [opts.entry] : []);
    args.push(...entries);
    return args;
};
const streamToLog = async (chunk, level, appendLog) => {
    const text = chunk.toString("utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (const line of lines) {
        await appendLog({
            timestamp: new Date().toISOString(),
            level,
            message: line,
        });
    }
};
const runVivliostyle = async (options) => {
    const args = buildArguments(options.cliOptions);
    const logPrefix = `[Job ${options.jobId}]`;
    logger_1.logger.info(`${logPrefix} starting Vivliostyle CLI`, { args });
    let timedOut = false;
    const child = (0, node_child_process_1.spawn)(process.execPath, [CLI_BIN, ...args], {
        cwd: options.workspaceDir,
        env: {
            ...process.env,
            NODE_ENV: process.env.NODE_ENV ?? "production",
        },
    });
    child.stdout?.on("data", (chunk) => {
        void streamToLog(chunk, "info", options.appendLog);
    });
    child.stderr?.on("data", (chunk) => {
        void streamToLog(chunk, "error", options.appendLog);
    });
    const timeout = config_1.config.cliTimeoutMs;
    let timeoutController;
    if (timeout > 0 && Number.isFinite(timeout)) {
        timeoutController = new AbortController();
        const { signal } = timeoutController;
        void (async () => {
            try {
                await (0, promises_1.setTimeout)(timeout, undefined, { signal });
                timedOut = true;
                logger_1.logger.warn(`${logPrefix} Vivliostyle CLI timed out after ${timeout}ms`);
                child.kill("SIGTERM");
                await (0, promises_1.setTimeout)(1_000);
                if (!child.killed) {
                    child.kill("SIGKILL");
                }
            }
            catch (error) {
                if (error.name !== "AbortError") {
                    logger_1.logger.error(`${logPrefix} timeout controller error`, { error });
                }
            }
        })();
    }
    return await new Promise((resolve, reject) => {
        child.once("error", (error) => {
            timeoutController?.abort();
            reject(error);
        });
        child.once("close", (code, signal) => {
            timeoutController?.abort();
            logger_1.logger.info(`${logPrefix} finished Vivliostyle CLI`, { code, signal });
            resolve({
                exitCode: code,
                signal,
                timedOut,
                args,
            });
        });
    });
};
exports.runVivliostyle = runVivliostyle;
function resolveCliBinary() {
    const pkgPath = require.resolve("@vivliostyle/cli/package.json");
    const pkg = JSON.parse((0, node_fs_1.readFileSync)(pkgPath, "utf8"));
    let binRelative;
    if (typeof pkg.bin === "string") {
        binRelative = pkg.bin;
    }
    else if (pkg.bin && typeof pkg.bin === "object") {
        binRelative = pkg.bin.vivliostyle ?? Object.values(pkg.bin)[0];
    }
    if (!binRelative) {
        throw new Error("Unable to resolve Vivliostyle CLI binary");
    }
    return node_path_1.default.resolve(node_path_1.default.dirname(pkgPath), binRelative);
}
//# sourceMappingURL=vivliostyleRunner.js.map