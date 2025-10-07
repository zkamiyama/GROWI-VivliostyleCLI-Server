"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = void 0;
const express_1 = __importDefault(require("express"));
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
const logAppendFactory = (jobId, store) => {
    return async (entry) => {
        await store.appendLog(jobId, entry);
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
const createServer = async () => {
    const app = (0, express_1.default)();
    const store = await (0, jobStore_1.createJobStore)();
    const queue = new jobQueue_1.JobQueue(config_1.config.concurrency);
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
            res.status(400).json({
                error: "validation_failed",
                details: parseResult.error.flatten(),
            });
            return;
        }
        const body = parseResult.data;
        const jobId = sanitizeJobId(body.jobId ?? (0, uuid_1.v4)());
        if (store.get(jobId)) {
            res.status(409).json({ error: "job_exists", jobId });
            return;
        }
        const base64Payload = body.sourceArchive.replace(/\s+/g, "");
        if (!BASE64_PATTERN.test(base64Payload) || base64Payload.length === 0) {
            res.status(400).json({ error: "invalid_base64" });
            return;
        }
        let archiveBuffer;
        try {
            archiveBuffer = Buffer.from(base64Payload, "base64");
        }
        catch {
            res.status(400).json({ error: "invalid_base64" });
            return;
        }
        const reEncoded = archiveBuffer.toString("base64").replace(/=+$/, "");
        const normalizedInput = base64Payload.replace(/=+$/, "");
        if (reEncoded !== normalizedInput) {
            res.status(400).json({ error: "invalid_base64" });
            return;
        }
        if (!archiveBuffer.length) {
            res.status(400).json({ error: "empty_archive" });
            return;
        }
        if (archiveBuffer.length > config_1.config.maxArchiveBytes) {
            res.status(400).json({
                error: "archive_too_large",
                limitBytes: config_1.config.maxArchiveBytes,
            });
            return;
        }
        const createdAt = new Date().toISOString();
        const jobRecord = {
            jobId,
            status: "created",
            createdAt,
            cliOptions: body.cliOptions ?? {},
            metadata: body.metadata,
            headers: {
                "user-agent": req.headers["user-agent"],
                "x-forwarded-for": req.headers["x-forwarded-for"],
                host: req.headers.host,
            },
        };
        await store.create(jobRecord, {
            archiveBuffer,
            requestSnapshot: {
                metadata: body.metadata,
            },
        });
        await store.markStatus(jobId, "queued");
        void queue.enqueue(jobId, async () => {
            await store.markStatus(jobId, "running");
            await store.appendLog(jobId, {
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
                    appendLog: logAppendFactory(jobId, store),
                });
                if (result.exitCode !== 0 || result.timedOut) {
                    await store.recordError(jobId, {
                        message: `Vivliostyle CLI exited with ${result.exitCode}`,
                        code: "cli_exit",
                        timedOut: result.timedOut,
                    });
                    return;
                }
                await store.recordArtifactManifest(jobId);
                await store.markStatus(jobId, "succeeded");
            }
            catch (error) {
                await store.recordError(jobId, {
                    message: error.message,
                    stack: error.stack,
                    code: "job_failure",
                });
                logger_1.logger.error(`Job ${jobId} failed`, { error: error.message });
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
        }).catch((error) => {
            logger_1.logger.error(`Queue execution failed for job ${jobId}`, { error });
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
        logger_1.logger.info(`Job ${job.jobId} deleted on request`);
        res.status(204).end();
    }));
    app.use((error, _req, res, _next) => {
        logger_1.logger.error("Unhandled error", { error });
        res.status(500).json({ error: "internal_error" });
    });
    return { app, store, queue };
};
exports.createServer = createServer;
//# sourceMappingURL=server.js.map