import type { Request, Response, NextFunction } from "express";
import express from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import path from "node:path";
import { mkdir } from "node:fs/promises";

import { config } from "./config";
import { extractZipArchive } from "./archive";
import { JobQueue } from "./jobQueue";
import { logger } from "./logger";
import { createJobStore, JobStore } from "./jobStore";
import type { CliOptionsInput, JobMetadata, JobRecord, JobStatus, LogEntry } from "./types";
import { runVivliostyle } from "./vivliostyleRunner";

const sanitizeJobId = (value: string): string => {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("jobId must contain alphanumeric characters, dot, underscore, or dash only");
  }
  return value;
};

const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/;
const CSS_MAX_BYTES = 256 * 1024;

class HttpError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(status: number, payload: Record<string, unknown>) {
    super(typeof payload.error === "string" ? payload.error : "HttpError");
    this.status = status;
    this.payload = payload;
  }
}

const cssOptionSchema = z.string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, {
    message: "cliOptions.css must not be empty",
  })
  .refine((value) => Buffer.byteLength(value, "utf8") <= CSS_MAX_BYTES, {
    message: `cliOptions.css exceeds maximum length of ${CSS_MAX_BYTES} bytes`,
  });

const cliOptionsSchema = z.object({
  configPath: z.string().min(1).optional(),
  entry: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  outputFile: z.string().min(1).optional(),
  format: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().positive().max(3600 * 24).optional(),
  additionalArgs: z.array(z.string().min(1)).optional(),
  css: cssOptionSchema.optional(),
  logLevel: z.enum(["silent", "info", "verbose", "debug"]).optional(),
});

const jobRequestSchema = z.object({
  jobId: z.string().min(3).max(64).optional(),
  sourceArchive: z.string().min(1, "sourceArchive is required"),
  cliOptions: cliOptionsSchema.default({}),
  metadata: z.record(z.any()).optional(),
});

const asyncHandler = <
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(
  handler: T,
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
};

const toSafeRelativePath = (value: string | undefined, fallback: string): string => {
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

const pickRequestHeaders = (req: Request) => ({
  "user-agent": req.headers["user-agent"],
  "x-forwarded-for": req.headers["x-forwarded-for"],
  host: req.headers.host,
});

export const createServer = async () => {
  const app = express();
  const store = await createJobStore();
  const queue = new JobQueue(config.concurrency);

  type LogSseClient = {
    res: Response;
    keepAlive: NodeJS.Timeout;
  };

  const logStreamClients = new Map<string, Set<LogSseClient>>();
  const autoCleanupTimers = new Map<string, NodeJS.Timeout>();

  const writeToClients = (jobId: string, chunk: string) => {
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

  const broadcastLogEntry = (jobId: string, entry: LogEntry) => {
    writeToClients(jobId, `event: jobs\ndata: ${JSON.stringify(entry)}\n\n`);
  };

  const broadcastStatus = (jobId: string, status: JobStatus) => {
    writeToClients(jobId, `event: status\ndata: ${JSON.stringify({ status })}\n\n`);
  };

  const registerLogStreamClient = (jobId: string, res: Response): LogSseClient => {
    const keepAlive = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`: keep-alive ${Date.now()}\n\n`);
      }
    }, 15000);
    const client: LogSseClient = { res, keepAlive };
    if (!logStreamClients.has(jobId)) {
      logStreamClients.set(jobId, new Set());
    }
    logStreamClients.get(jobId)!.add(client);
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

  const closeLogStreamClients = (jobId: string, payload?: Record<string, unknown>) => {
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

  const withJobsPrefix = (entry: LogEntry): LogEntry => {
    if (entry.message.startsWith("[jobs]")) {
      return entry;
    }
    return {
      ...entry,
      message: `[jobs] ${entry.message}`,
    };
  };

  const appendLogEntry = async (jobId: string, entry: LogEntry) => {
    const normalized = withJobsPrefix(entry);
    await store.appendLog(jobId, normalized);
    broadcastLogEntry(jobId, normalized);
  };

  const logJob = (
    jobId: string,
    message: string,
    level: LogEntry["level"] = "info",
    details?: Record<string, unknown>,
  ) => appendLogEntry(jobId, {
    timestamp: new Date().toISOString(),
    level,
    message,
    details,
  });

  const cancelAutoCleanup = async (jobId: string, reason: string) => {
    const timer = autoCleanupTimers.get(jobId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    autoCleanupTimers.delete(jobId);
    if (store.get(jobId)) {
      await logJob(jobId, `Auto-cleanup timer cancelled (${reason})`, "debug");
    }
  };

  const probeFrontend = async (jobId: string): Promise<void> => {
    if (!config.frontendPingUrl) {
      await logJob(jobId, "Frontend probe skipped (VIV_FRONTEND_PING_URL not set)", "debug");
      return;
    }
    const timeout = config.frontendPingTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(config.frontendPingUrl, {
        method: "HEAD",
        signal: controller.signal,
        headers: {
          "cache-control": "no-cache",
        },
      });
      await logJob(jobId, "Frontend probe completed", response.ok ? "debug" : "warn", {
        url: config.frontendPingUrl,
        status: response.status,
        ok: response.ok,
      });
    } catch (error) {
      const level: LogEntry["level"] = (error as Error).name === "AbortError" ? "warn" : "error";
      await logJob(jobId, "Frontend probe failed", level, {
        url: config.frontendPingUrl,
        error: (error as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  const handleAutoCleanup = async (jobId: string): Promise<void> => {
    autoCleanupTimers.delete(jobId);
    const job = store.get(jobId);
    if (!job) {
      return;
    }
    await logJob(jobId, "Auto-cleanup timer expired; probing frontend before cleanup", "info", {
      timeoutMs: config.autoCleanupTimeoutMs,
    });
    await probeFrontend(jobId);
    try {
      await logJob(jobId, "Auto-cleanup removing job directory", "info");
      await store.deleteJob(jobId);
      closeLogStreamClients(jobId, { status: job.status, reason: "auto_cleanup" });
      logger.info(`[jobs] Auto-cleanup removed job ${jobId}`);
    } catch (error) {
      logger.error(`Auto-cleanup failed for job ${jobId}`, { error });
      await logJob(jobId, "Auto-cleanup failed", "error", {
        error: (error as Error).message,
      });
    }
  };

  const scheduleAutoCleanup = async (jobId: string, status: JobStatus) => {
    if (config.autoCleanupTimeoutMs <= 0) {
      await logJob(jobId, "Auto-cleanup disabled (timeout <= 0)", "debug", { status });
      return;
    }
    await cancelAutoCleanup(jobId, "reschedule");
    const due = new Date(Date.now() + config.autoCleanupTimeoutMs).toISOString();
    autoCleanupTimers.set(
      jobId,
      setTimeout(() => {
        void handleAutoCleanup(jobId).catch((error) => {
          logger.error(`Auto-cleanup handler failed for job ${jobId}`, { error });
        });
      }, config.autoCleanupTimeoutMs),
    );
    await logJob(jobId, "Auto-cleanup timer armed", "info", {
      status,
      timeoutMs: config.autoCleanupTimeoutMs,
      dueAt: due,
    });
  };
  const multipartJobHandler = asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file?.buffer?.length) {
      throw new HttpError(400, { error: "zip_missing" });
    }

    const pageId = typeof req.body?.pageId === "string" ? req.body.pageId : undefined;
    const pagePath = typeof req.body?.pagePath === "string" ? req.body.pagePath : undefined;
    const rawTitle = typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
    const rawCliOptions = typeof req.body?.cliOptions === "string" ? req.body.cliOptions : undefined;

    let cliOptions: CliOptionsInput | undefined;
    if (rawCliOptions) {
      let parsedCliOptions: unknown;
      try {
        parsedCliOptions = JSON.parse(rawCliOptions);
      } catch {
        throw new HttpError(400, { error: "invalid_cli_options_json" });
      }
      const cliParseResult = cliOptionsSchema.safeParse(parsedCliOptions);
      if (!cliParseResult.success) {
        throw new HttpError(400, {
          error: "invalid_cli_options",
          details: cliParseResult.error.flatten(),
        });
      }
      cliOptions = cliParseResult.data;
    }

    const metadata: JobMetadata = {
      title: rawTitle || undefined,
      pageId,
      pagePath,
      source: "multipart-form",
    };

    const { jobId, createdAt } = await submitJob({
      jobIdInput: normalizeJobIdCandidate(pageId),
      archiveBuffer: file.buffer,
      cliOptions,
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
  });

  const jsonJobHandler = asyncHandler(async (req, res) => {
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

    let archiveBuffer: Buffer;
    try {
      archiveBuffer = Buffer.from(base64Payload, "base64");
    } catch {
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
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: config.maxArchiveBytes,
      files: 1,
    },
  });

  const scheduleJob = (jobId: string) => {
    void queue.enqueue(jobId, async () => {
      await store.markStatus(jobId, "running");
      broadcastStatus(jobId, "running");
      const appendLogForJob = (entry: LogEntry) => appendLogEntry(jobId, entry);

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
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Extracting archive to workspace",
          details: { workspaceDir },
        });
        await extractZipArchive(archivePath, workspaceDir);
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Archive extracted",
          details: { workspaceDir },
        });

        const safeOutputRelative = toSafeRelativePath(
          job.cliOptions.outputFile,
          `${jobId}.pdf`,
        );
        const outputAbsolute = path.resolve(outputDir, safeOutputRelative);

        await mkdir(path.dirname(outputAbsolute), { recursive: true });
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "debug",
          message: "Ensured output directory exists",
          details: { outputRelative: safeOutputRelative },
        });

        await store.update(jobId, {
          artifact: {
            primaryFile: safeOutputRelative,
            files: [],
          },
        });
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "debug",
          message: "Job record updated with primary artifact placeholder",
          details: { outputRelative: safeOutputRelative },
        });

        const effectiveOptions = {
          ...job.cliOptions,
          outputFile: outputAbsolute,
        };
        const launchDetails: Record<string, unknown> = {
          outputFile: safeOutputRelative,
          entries: effectiveOptions.entry,
        };
        if (typeof job.cliOptions.css === "string") {
          launchDetails.cssBytes = Buffer.byteLength(job.cliOptions.css, "utf8");
        }
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Launching Vivliostyle CLI",
          details: launchDetails,
        });

        const result = await runVivliostyle({
          jobId,
          workspaceDir,
          cliOptions: effectiveOptions,
          appendLog: appendLogForJob,
        });
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: result.timedOut ? "warn" : "info",
          message: "Vivliostyle CLI completed",
          details: {
            exitCode: result.exitCode,
            signal: result.signal ?? undefined,
            timedOut: result.timedOut,
          },
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
          await scheduleAutoCleanup(jobId, "failed");
          return;
        }

        const manifest = await store.recordArtifactManifest(jobId);
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Artifact manifest recorded",
          details: {
            files: manifest.files.length,
            primaryFile: manifest.primaryFile,
          },
        });
        await store.markStatus(jobId, "succeeded");
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "info",
          message: "Job marked as succeeded",
        });
        broadcastStatus(jobId, "succeeded");
        closeLogStreamClients(jobId, { status: "succeeded" });
        await scheduleAutoCleanup(jobId, "succeeded");
      } catch (error) {
        await appendLogForJob({
          timestamp: new Date().toISOString(),
          level: "error",
          message: "Job failed",
          details: { error: (error as Error).message },
        });
        await store.recordError(jobId, {
          message: (error as Error).message,
          stack: (error as Error).stack,
          code: "job_failure",
        });
        logger.error(`Job ${jobId} failed`, { error: (error as Error).message });
        broadcastStatus(jobId, "failed");
        closeLogStreamClients(jobId, {
          status: "failed",
          reason: "job_failure",
          message: (error as Error).message,
        });
        await scheduleAutoCleanup(jobId, "failed");
      } finally {
        try {
          await appendLogForJob({
            timestamp: new Date().toISOString(),
            level: "debug",
            message: "Cleaning up temporary input artifacts",
          });
          await store.cleanupInput(jobId);
          await appendLogForJob({
            timestamp: new Date().toISOString(),
            level: "debug",
            message: "Temporary input artifacts removed",
          });
        } catch (cleanupError) {
          logger.warn(`Cleanup failed for job ${jobId}`, {
            error: (cleanupError as Error).message,
          });
        }
      }
    }).catch(async (error) => {
      logger.error(`Queue execution failed for job ${jobId}`, { error });
      await appendLogEntry(jobId, {
        timestamp: new Date().toISOString(),
        level: "error",
        message: "Job queue execution failed",
        details: { error: (error as Error).message },
      });
      await store.recordError(jobId, {
        message: (error as Error).message,
        stack: (error as Error).stack,
        code: "queue_failure",
      });
      broadcastStatus(jobId, "failed");
      closeLogStreamClients(jobId, {
        status: "failed",
        reason: "queue_failure",
        message: (error as Error).message,
      });
    });
  };

  interface SubmitJobOptions {
    jobIdInput?: string;
    archiveBuffer: Buffer;
    metadata?: JobMetadata;
    cliOptions?: CliOptionsInput;
    headerSnapshot: ReturnType<typeof pickRequestHeaders>;
    requestSnapshot?: Record<string, unknown>;
  }

  const submitJob = async ({
    jobIdInput,
    archiveBuffer,
    metadata,
    cliOptions,
    headerSnapshot,
    requestSnapshot = {},
  }: SubmitJobOptions) => {
    let jobId: string;
    try {
      jobId = sanitizeJobId(jobIdInput ?? uuid());
    } catch {
      throw new HttpError(400, { error: "invalid_job_id" });
    }

    if (store.get(jobId)) {
      throw new HttpError(409, { error: "job_exists", jobId });
    }

    if (!archiveBuffer.length) {
      throw new HttpError(400, { error: "empty_archive" });
    }

    if (archiveBuffer.length > config.maxArchiveBytes) {
      throw new HttpError(400, {
        error: "archive_too_large",
        limitBytes: config.maxArchiveBytes,
      });
    }

    const createdAt = new Date().toISOString();
    const jobRecord: JobRecord = {
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

    await logJob(jobId, "Job registered", "info", {
      archiveBytes: archiveBuffer.length,
      requestSource: requestSnapshot.source ?? metadata?.source ?? "unknown",
    });

    await store.markStatus(jobId, "queued");
    broadcastStatus(jobId, "queued");
    await logJob(jobId, "Job status updated to queued", "debug");
    scheduleJob(jobId);
    await logJob(jobId, "Job submitted to execution queue", "debug");

    return { jobId, createdAt };
  };

  const normalizeJobIdCandidate = (value: unknown): string | undefined => {
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

  const jsonLimitMb = Math.max(
    1,
    Math.ceil((config.maxArchiveBytes * 4) / (3 * 1024 * 1024)),
  );
  app.use(express.json({ limit: `${jsonLimitMb}mb` }));

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
    });
  });

  app.post("/vivliostyle/jobs", (req, res, next) => {
    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return next();
    }
    upload.single("zip")(req, res, (err) => {
      if (err) {
        next(err);
        return;
      }
      multipartJobHandler(req, res, next);
    });
  });

  app.post("/vivliostyle/jobs", jsonJobHandler);

  app.get(
    "/vivliostyle/jobs/:jobId",
    asyncHandler(async (req, res) => {
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
    }),
  );

  app.get(
    "/vivliostyle/jobs/:jobId/result",
    asyncHandler(async (req, res) => {
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

      await logJob(job.jobId, "Result download requested", "info", {
        file: targetFile,
      });

      const stream = store.createArtifactReadStream(job.jobId, targetFile);
      stream.on("error", (error) => {
        logger.error(`Failed to stream artifact ${targetFile}`, { error });
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.destroy(error);
        }
      });

      res.setHeader("Content-Type", job.artifact?.files.find((file) => file.path === targetFile)?.mime ?? "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(targetFile)}"`,
      );

      stream.pipe(res);
    }),
  );

  app.get(
    "/vivliostyle/jobs/:jobId/log",
    asyncHandler(async (req, res) => {
      const job = store.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }

      const stream = store.createLogReadStream(job.jobId);
      stream.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          res.status(204).end();
          return;
        }
        logger.error(`Failed to stream logs for job ${job.jobId}`, { error });
        res.status(500).end();
      });
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      stream.pipe(res);
    }),
  );

  app.get(
    "/vivliostyle/jobs/:jobId/log/stream",
    asyncHandler(async (req, res) => {
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
          res.write(`event: jobs\ndata: ${line}\n\n`);
        }
      }

      res.write(`event: status\ndata: ${JSON.stringify({ status: job.status })}\n\n`);

      if (job.status === "succeeded" || job.status === "failed") {
        res.write(`event: complete\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
        res.end();
        return;
      }

      registerLogStreamClient(jobId, res);
    }),
  );

  app.delete(
    "/vivliostyle/jobs/:jobId",
    asyncHandler(async (req, res) => {
      const job = store.get(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: "job_not_found" });
        return;
      }

      if (job.status === "running" || job.status === "queued" || job.status === "created") {
        res.status(409).json({ error: "job_in_progress", status: job.status });
        return;
      }

      await logJob(job.jobId, "Manual delete requested", "info");
      await cancelAutoCleanup(job.jobId, "manual_delete");
      await store.deleteJob(job.jobId);
      closeLogStreamClients(job.jobId, { status: job.status, reason: "job_deleted" });
      logger.info(`Job ${job.jobId} deleted on request`);
      res.status(204).end();
    }),
  );

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof HttpError) {
      res.status(error.status).json(error.payload);
      return;
    }
    if (error instanceof MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({
          error: "archive_too_large",
          limitBytes: config.maxArchiveBytes,
        });
      } else {
        res.status(400).json({
          error: "invalid_multipart",
          code: error.code,
        });
      }
      return;
    }
    logger.error("Unhandled error", { error });
    res.status(500).json({ error: "internal_error" });
  });

  return { app, store, queue };
};










