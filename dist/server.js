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
exports.createServer = void 0;
const express_1 = __importDefault(require("express"));
const multer_1 = __importStar(require("multer"));
const zod_1 = require("zod");
const uuid_1 = require("uuid");
const node_path_1 = __importDefault(require("node:path"));
const promises_1 = require("node:fs/promises");
const config_1 = require("./config");
const archive_1 = require("./archive");
const jobQueue_1 = require("./jobQueue");
const logger_1 = require("./logger");
const jobStore_1 = require("./jobStore");
const vivliostyleRunner_1 = require("./vivliostyleRunner");
const sanitizeJobId = (value) => {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
        throw new Error("jobId must contain alphanumeric characters, dot, underscore, or dash only");
    }
    return value;
};
const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/;
class HttpError extends Error {
    status;
    payload;
    constructor(status, payload) {
        super(typeof payload.error === "string" ? payload.error : "HttpError");
        this.status = status;
        this.payload = payload;
    }
}
const jobRequestSchema = zod_1.z.object({
    jobId: zod_1.z.string().min(3).max(64).optional(),
    sourceArchive: zod_1.z.string().min(1, "sourceArchive is required"),
    cliOptions: zod_1.z.object({
        configPath: zod_1.z.string().min(1).optional(),
        entry: zod_1.z.union([zod_1.z.string().min(1), zod_1.z.array(zod_1.z.string().min(1))]).optional(),
        outputFile: zod_1.z.string().min(1).optional(),
        format: zod_1.z.string().min(1).optional(),
        timeoutSeconds: zod_1.z.number().int().positive().max(3600 * 24).optional(),
        additionalArgs: zod_1.z.array(zod_1.z.string().min(1)).optional(),
    }).default({}),
    metadata: zod_1.z.record(zod_1.z.any()).optional(),
});
const asyncHandler = (handler) => {
    return (req, res, next) => {
        handler(req, res, next).catch(next);
    };
};
const toSafeRelativePath = (value, fallback) => {
    if (!value) {
        return fallback;
    }
    const normalized = value.replace(/\\/g, "/");
    const parts = normalized.split("/").filter(Boolean);
    if (parts.some((part) => part === "..")) {
        throw new Error("outputFile must not contain '..' path segments");
    }
    return parts.join("/") || fallback;
};
const pickRequestHeaders = (req) => ({
    "user-agent": req.headers["user-agent"],
    "x-forwarded-for": req.headers["x-forwarded-for"],
    host: req.headers.host,
});
const createServer = async () => {
    const app = (0, express_1.default)();
    const store = await (0, jobStore_1.createJobStore)();
    const queue = new jobQueue_1.JobQueue(config_1.config.concurrency);
    const logStreamClients = new Map();
    const writeToClients = (jobId, chunk) => {
        const clients = logStreamClients.get(jobId);
        if (!clients) {
            return;
        }
        for (const client of [...clients]) {
            if (client.res.writableEnded || client.res.destroyed) {
                clearInterval(client.keepAlive);
                clients.delete(client);
                continue;
            }
            client.res.write(chunk);
        }
        if (clients.size === 0) {
            logStreamClients.delete(jobId);
        }
    };
    const broadcastLogEntry = (jobId, entry) => {
        writeToClients(jobId, `data: ${JSON.stringify(entry)}\n\n`);
    };
    const broadcastStatus = (jobId, status) => {
        writeToClients(jobId, `event: status\ndata: ${JSON.stringify({ status })}\n\n`);
    };
    const registerLogStreamClient = (jobId, res) => {
        const keepAlive = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) {
                res.write(`: keep-alive ${Date.now()}\n\n`);
            }
        }, 15000);
        const client = { res, keepAlive };
        if (!logStreamClients.has(jobId)) {
            logStreamClients.set(jobId, new Set());
        }
        logStreamClients.get(jobId).add(client);
        res.on("close", () => {
            clearInterval(keepAlive);
            const clients = logStreamClients.get(jobId);
            if (!clients) {
                return;
            }
            clients.delete(client);
            if (clients.size === 0) {
                logStreamClients.delete(jobId);
            }
        });
        return client;
    };
    const closeLogStreamClients = (jobId, payload) => {
        const clients = logStreamClients.get(jobId);
        if (!clients) {
            return;
        }
        const message = payload ? `event: complete\ndata: ${JSON.stringify(payload)}\n\n` : "";
        for (const client of clients) {
            clearInterval(client.keepAlive);
            if (!client.res.writableEnded && !client.res.destroyed) {
                if (message) {
                    client.res.write(message);
                }
                client.res.end();
            }
        }
        logStreamClients.delete(jobId);
    };
    const appendLogEntry = async (jobId, entry) => {
        await store.appendLog(jobId, entry);
        broadcastLogEntry(jobId, entry);
    };
    const upload = (0, multer_1.default)({
        storage: multer_1.default.memoryStorage(),
        limits: {
            fileSize: config_1.config.maxArchiveBytes,
            files: 1,
        },
    });
    const scheduleJob = (jobId) => {
        void queue.enqueue(jobId, async () => {
            await store.markStatus(jobId, "running");
            broadcastStatus(jobId, "running");
            const appendLogForJob = (entry) => appendLogEntry(jobId, entry);
            await appendLogForJob({
                timestamp: new Date().toISOString(),
                level: "info",
                message: "Job started",
            });
            const archivePath = store.getArchivePath(jobId);
            const workspaceDir = store.workspaceDir(jobId);
            const outputDir = store.outputDir(jobId);
            const job = store.get(jobId);
            if (!job) {
                throw new Error(`Job ${jobId} disappeared`);
            }
            try {
                await (0, archive_1.extractZipArchive)(archivePath, workspaceDir);
                const safeOutputRelative = toSafeRelativePath(job.cliOptions.outputFile, `${jobId}.pdf`);
                const outputAbsolute = node_path_1.default.resolve(outputDir, safeOutputRelative);
                await (0, promises_1.mkdir)(node_path_1.default.dirname(outputAbsolute), { recursive: true });
                await store.update(jobId, {
                    artifact: {
                        primaryFile: safeOutputRelative,
                        files: [],
                    },
                });
                const effectiveOptions = {
                    ...job.cliOptions,
                    outputFile: outputAbsolute,
                };
                const result = await (0, vivliostyleRunner_1.runVivliostyle)({
                    jobId,
                    workspaceDir,
                    cliOptions: effectiveOptions,
                    appendLog: appendLogForJob,
                });
                if (result.exitCode !== 0 || result.timedOut) {
                    await appendLogForJob({
                        timestamp: new Date().toISOString(),
                        level: "error",
                        message: "Vivliostyle CLI exited abnormally",
                        details: { exitCode: result.exitCode, timedOut: result.timedOut },
                    });
                    await store.recordError(jobId, {
                        message: `Vivliostyle CLI exited with ${result.exitCode}`,
                        code: "cli_exit",
                        timedOut: result.timedOut,
                    });
                    broadcastStatus(jobId, "failed");
                    closeLogStreamClients(jobId, {
                        status: "failed",
                        reason: "cli_exit",
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                    });
                    return;
                }
                await store.recordArtifactManifest(jobId);
                await store.markStatus(jobId, "succeeded");
                broadcastStatus(jobId, "succeeded");
                closeLogStreamClients(jobId, { status: "succeeded" });
            }
            catch (error) {
                await appendLogForJob({
                    timestamp: new Date().toISOString(),
                    level: "error",
                    message: "Job failed",
                    details: { error: error.message },
                });
                await store.recordError(jobId, {
                    message: error.message,
                    stack: error.stack,
                    code: "job_failure",
                });
                logger_1.logger.error(`Job ${jobId} failed`, { error: error.message });
                broadcastStatus(jobId, "failed");
                closeLogStreamClients(jobId, {
                    status: "failed",
                    reason: "job_failure",
                    message: error.message,
                });
            }
            finally {
                try {
                    await store.cleanupInput(jobId);
                }
                catch (cleanupError) {
                    logger_1.logger.warn(`Cleanup failed for job ${jobId}`, {
                        error: cleanupError.message,
                    });
                }
            }
        }).catch(async (error) => {
            logger_1.logger.error(`Queue execution failed for job ${jobId}`, { error });
            await appendLogEntry(jobId, {
                timestamp: new Date().toISOString(),
                level: "error",
                message: "Job queue execution failed",
                details: { error: error.message },
            });
            await store.recordError(jobId, {
                message: error.message,
                stack: error.stack,
                code: "queue_failure",
            });
            broadcastStatus(jobId, "failed");
            closeLogStreamClients(jobId, {
                status: "failed",
                reason: "queue_failure",
                message: error.message,
            });
        });
    };
    const submitJob = async ({ jobIdInput, archiveBuffer, metadata, cliOptions, headerSnapshot, requestSnapshot = {}, }) => {
        let jobId;
        try {
            jobId = sanitizeJobId(jobIdInput ?? (0, uuid_1.v4)());
        }
        catch {
            throw new HttpError(400, { error: "invalid_job_id" });
        }
        if (store.get(jobId)) {
            throw new HttpError(409, { error: "job_exists", jobId });
        }
        if (!archiveBuffer.length) {
            throw new HttpError(400, { error: "empty_archive" });
        }
        if (archiveBuffer.length > config_1.config.maxArchiveBytes) {
            throw new HttpError(400, {
                error: "archive_too_large",
                limitBytes: config_1.config.maxArchiveBytes,
            });
        }
        const createdAt = new Date().toISOString();
        const jobRecord = {
            jobId,
            status: "created",
            createdAt,
            cliOptions: cliOptions ?? {},
            metadata,
            headers: headerSnapshot,
        };
        await store.create(jobRecord, {
            archiveBuffer,
            requestSnapshot,
        });
        await store.markStatus(jobId, "queued");
        broadcastStatus(jobId, "queued");
        scheduleJob(jobId);
        return { jobId, createdAt };
    };
    const normalizeJobIdCandidate = (value) => {
        if (typeof value !== "string") {
            return undefined;
        }
        const trimmed = value.trim();
        if (!trimmed) {
            return undefined;
        }
        const normalized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
        return normalized || undefined;
    };
    const jsonLimitMb = Math.max(1, Math.ceil((config_1.config.maxArchiveBytes * 4) / (3 * 1024 * 1024)));
    app.use(express_1.default.json({ limit: `${jsonLimitMb}mb` }));
    app.get("/healthz", (_req, res) => {
        res.json({
            status: "ok",
            uptime: process.uptime(),
        });
    });
    app.post("/api/v1/jobs", asyncHandler(async (req, res) => {
        const parseResult = jobRequestSchema.safeParse(req.body);
        if (!parseResult.success) {
            throw new HttpError(400, {
                error: "validation_failed",
                details: parseResult.error.flatten(),
            });
        }
        const body = parseResult.data;
        const base64Payload = body.sourceArchive.replace(/\s+/g, "");
        if (!BASE64_PATTERN.test(base64Payload) || base64Payload.length === 0) {
            throw new HttpError(400, { error: "invalid_base64" });
        }
        let archiveBuffer;
        try {
            archiveBuffer = Buffer.from(base64Payload, "base64");
        }
        catch {
            throw new HttpError(400, { error: "invalid_base64" });
        }
        const reEncoded = archiveBuffer.toString("base64").replace(/=+$/, "");
        const normalizedInput = base64Payload.replace(/=+$/, "");
        if (reEncoded !== normalizedInput) {
            throw new HttpError(400, { error: "invalid_base64" });
        }
        const { jobId, createdAt } = await submitJob({
            jobIdInput: body.jobId,
            archiveBuffer,
            metadata: body.metadata,
            cliOptions: body.cliOptions,
            headerSnapshot: pickRequestHeaders(req),
            requestSnapshot: {
                source: "json-base64",
            },
        });
        res.status(202).json({
            jobId,
            status: "queued",
            createdAt,
        });
    }));
    app.post("/vivliostyle/jobs", upload.single("zip"), asyncHandler(async (req, res) => {
        const file = req.file;
        if (!file?.buffer?.length) {
            throw new HttpError(400, { error: "zip_missing" });
        }
        const pageId = typeof req.body?.pageId === "string" ? req.body.pageId : undefined;
        const pagePath = typeof req.body?.pagePath === "string" ? req.body.pagePath : undefined;
        const rawTitle = typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
        const metadata = {
            title: rawTitle || undefined,
            pageId,
            pagePath,
            source: "multipart-form",
        };
        const { jobId, createdAt } = await submitJob({
            jobIdInput: normalizeJobIdCandidate(pageId),
            archiveBuffer: file.buffer,
            metadata,
            headerSnapshot: pickRequestHeaders(req),
            requestSnapshot: {
                source: "multipart-form",
                pageId,
                pagePath,
                title: rawTitle,
            },
        });
        res.status(202).json({
            jobId,
            status: "queued",
            createdAt,
        });
    }));
    app.get("/api/v1/jobs/:jobId", asyncHandler(async (req, res) => {
        const job = store.get(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: "job_not_found" });
            return;
        }
        const logTail = await store.readLogTail(job.jobId);
        res.json({
            ...job,
            logTail,
            queue: {
                size: queue.size,
                pending: queue.pending,
            },
        });
    }));
    app.get("/api/v1/jobs/:jobId/result", asyncHandler(async (req, res) => {
        const job = store.get(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: "job_not_found" });
            return;
        }
        if (job.status !== "succeeded") {
            res.status(409).json({ error: "job_not_ready", status: job.status });
            return;
        }
        const requestedFile = typeof req.query.file === "string"
            ? req.query.file
            : undefined;
        const targetFile = requestedFile ?? job.artifact?.primaryFile;
        if (!targetFile) {
            res.status(404).json({ error: "artifact_not_found" });
            return;
        }
        const exists = await store.artifactFileExists(job.jobId, targetFile);
        if (!exists) {
            res.status(404).json({ error: "artifact_missing", file: targetFile });
            return;
        }
        const stream = store.createArtifactReadStream(job.jobId, targetFile);
        stream.on("error", (error) => {
            logger_1.logger.error(`Failed to stream artifact ${targetFile}`, { error });
            if (!res.headersSent) {
                res.status(500).end();
            }
            else {
                res.destroy(error);
            }
        });
        res.setHeader("Content-Type", job.artifact?.files.find((file) => file.path === targetFile)?.mime ?? "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${node_path_1.default.basename(targetFile)}"`);
        stream.pipe(res);
    }));
    app.get("/api/v1/jobs/:jobId/log", asyncHandler(async (req, res) => {
        const job = store.get(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: "job_not_found" });
            return;
        }
        const stream = store.createLogReadStream(job.jobId);
        stream.on("error", (error) => {
            if (error.code === "ENOENT") {
                res.status(204).end();
                return;
            }
            logger_1.logger.error(`Failed to stream logs for job ${job.jobId}`, { error });
            res.status(500).end();
        });
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        stream.pipe(res);
    }));
    app.get("/api/v1/jobs/:jobId/log/stream", asyncHandler(async (req, res) => {
        const jobId = req.params.jobId;
        const job = store.get(jobId);
        if (!job) {
            res.status(404).json({ error: "job_not_found" });
            return;
        }
        res.status(200);
        res.set({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        if (typeof res.flushHeaders === "function") {
            res.flushHeaders();
        }
        const existingLog = await store.readLog(jobId);
        if (existingLog) {
            for (const line of existingLog.split(/\r?\n/).filter(Boolean)) {
                res.write(`data: ${line}\n\n`);
            }
        }
        res.write(`event: status\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
        if (job.status === "succeeded" || job.status === "failed") {
            res.write(`event: complete\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
            res.end();
            return;
        }
        registerLogStreamClient(jobId, res);
    }));
    app.delete("/api/v1/jobs/:jobId", asyncHandler(async (req, res) => {
        const job = store.get(req.params.jobId);
        if (!job) {
            res.status(404).json({ error: "job_not_found" });
            return;
        }
        if (job.status === "running" || job.status === "queued" || job.status === "created") {
            res.status(409).json({ error: "job_in_progress", status: job.status });
            return;
        }
        await store.deleteJob(job.jobId);
        closeLogStreamClients(job.jobId, { status: job.status, reason: "job_deleted" });
        logger_1.logger.info(`Job ${job.jobId} deleted on request`);
        res.status(204).end();
    }));
    app.use((error, _req, res, _next) => {
        if (error instanceof HttpError) {
            res.status(error.status).json(error.payload);
            return;
        }
        if (error instanceof multer_1.MulterError) {
            if (error.code === "LIMIT_FILE_SIZE") {
                res.status(400).json({
                    error: "archive_too_large",
                    limitBytes: config_1.config.maxArchiveBytes,
                });
            }
            else {
                res.status(400).json({
                    error: "invalid_multipart",
                    code: error.code,
                });
            }
            return;
        }
        logger_1.logger.error("Unhandled error", { error });
        res.status(500).json({ error: "internal_error" });
    });
    return { app, store, queue };
};
exports.createServer = createServer;
//# sourceMappingURL=server.js.map