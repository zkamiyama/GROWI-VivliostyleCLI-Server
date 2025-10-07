import { createReadStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
  appendFile,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { config } from "./config";
import type {
  ArtifactFile,
  JobArtifactSummary,
  JobError,
  JobRecord,
  JobStatus,
  LogEntry,
} from "./types";

const LOG_TAIL_LENGTH = 50;

const ensureTrailingSep = (value: string): string =>
  value.endsWith(path.sep) ? value : `${value}${path.sep}`;

const within = (base: string, target: string): string => {
  const baseResolved = path.resolve(base);
  const resolved = path.resolve(baseResolved, target);
  const normalizedBase = ensureTrailingSep(baseResolved);
  if (resolved === baseResolved) {
    return resolved;
  }
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  return resolved;
};

const now = (): string => new Date().toISOString();

export class JobStore {
  private readonly baseDir: string;
  private readonly jobs = new Map<string, JobRecord>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    const entries = await readdir(this.baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const jobId = entry.name;
      const jobRecordPath = this.jobPath(jobId, "job.json");
      try {
        const json = await readFile(jobRecordPath, "utf8");
        const data = JSON.parse(json) as JobRecord;

        if (data.status === "running") {
          data.status = "failed";
          data.completedAt = now();
          data.error = {
            message: "Job marked as running but server restarted.",
            code: "server-restart",
          };
          await this.writeJobRecord(jobId, data);
        }

        this.jobs.set(jobId, data);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          `[JobStore] failed to load record for job ${jobId}:`,
          error,
        );
      }
    }
  }

  listJobs(): JobRecord[] {
    return [...this.jobs.values()].sort(
      (a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf(),
    );
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  async create(job: JobRecord, opts: {
    archiveBuffer: Buffer;
    requestSnapshot: Record<string, unknown>;
  }): Promise<JobRecord> {
    if (this.jobs.has(job.jobId)) {
      throw new Error(`Job ${job.jobId} already exists`);
    }

    const dir = this.jobDir(job.jobId);
    await mkdir(dir, { recursive: false });
    await mkdir(this.workspaceDir(job.jobId), { recursive: true });
    await mkdir(this.outputDir(job.jobId), { recursive: true });

    const snapshot = {
      jobId: job.jobId,
      cliOptions: job.cliOptions,
      metadata: job.metadata ?? {},
      ...opts.requestSnapshot,
    };
    await writeFile(
      this.jobPath(job.jobId, "request.json"),
      JSON.stringify(snapshot, null, 2),
      "utf8",
    );

    await writeFile(this.jobPath(job.jobId, "source.zip"), opts.archiveBuffer);

    this.jobs.set(job.jobId, job);
    await this.writeJobRecord(job.jobId, job);
    return job;
  }

  async update(jobId: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const current = this.require(jobId);
    const next: JobRecord = {
      ...current,
      ...patch,
      cliOptions: patch.cliOptions ?? current.cliOptions,
      metadata: patch.metadata ?? current.metadata,
      artifact: patch.artifact ?? current.artifact,
      error: patch.error ?? current.error,
    };
    this.jobs.set(jobId, next);
    await this.writeJobRecord(jobId, next);
    return next;
  }

  async markStatus(jobId: string, status: JobStatus): Promise<JobRecord> {
    const current = this.require(jobId);
    const patch: Partial<JobRecord> = { status };
    if (status === "queued") {
      patch.queuedAt = now();
    } else if (status === "running") {
      patch.startedAt = now();
    } else if (status === "succeeded" || status === "failed") {
      patch.completedAt = now();
    }
    return this.update(jobId, patch);
  }

  async recordError(jobId: string, error: JobError): Promise<JobRecord> {
    return this.update(jobId, {
      status: "failed",
      error,
      completedAt: now(),
    });
  }

  async recordArtifactManifest(jobId: string): Promise<JobArtifactSummary> {
    const files = await this.collectArtifacts(jobId);
    const primary =
      files.find((file) => file.path === this.require(jobId).artifact?.primaryFile)
        ?.path ??
      files.find((file) => file.path.endsWith(".pdf"))?.path ??
      files[0]?.path ??
      null;
    const summary: JobArtifactSummary = {
      primaryFile: primary,
      files,
    };
    await this.update(jobId, { artifact: summary });
    return summary;
  }

  async appendLog(jobId: string, entry: LogEntry): Promise<void> {
    const line = JSON.stringify(entry);
    await appendFile(
      this.jobPath(jobId, "log.ndjson"),
      `${line}\n`,
      "utf8",
    );
  }

  async readLog(jobId: string): Promise<string> {
    try {
      return await readFile(this.jobPath(jobId, "log.ndjson"), "utf8");
    } catch {
      return "";
    }
  }

  async readLogTail(jobId: string, limit = LOG_TAIL_LENGTH): Promise<string[]> {
    const content = await this.readLog(jobId);
    if (!content) {
      return [];
    }
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit);
  }

  getArchivePath(jobId: string): string {
    return this.jobPath(jobId, "source.zip");
  }

  workspaceDir(jobId: string): string {
    return this.jobPath(jobId, "workspace");
  }

  outputDir(jobId: string): string {
    return this.jobPath(jobId, "output");
  }

  logPath(jobId: string): string {
    return this.jobPath(jobId, "log.ndjson");
  }

  artifactFileAbsolutePath(jobId: string, relative: string): string {
    return within(this.outputDir(jobId), relative);
  }

  artifactFileExists(jobId: string, relative: string): Promise<boolean> {
    const target = this.artifactFileAbsolutePath(jobId, relative);
    return stat(target)
      .then((info) => info.isFile())
      .catch(() => false);
  }

  createArtifactReadStream(jobId: string, relative: string) {
    const target = this.artifactFileAbsolutePath(jobId, relative);
    return createReadStream(target);
  }

  createLogReadStream(jobId: string) {
    return createReadStream(this.logPath(jobId));
  }

  async cleanupInput(jobId: string): Promise<void> {
    const targets = [
      this.getArchivePath(jobId),
      this.workspaceDir(jobId),
    ];

    await Promise.allSettled(
      targets.map(async (target) => {
        await rm(target, { recursive: true, force: true });
      }),
    );
  }

  async deleteJob(jobId: string): Promise<void> {
    if (!this.jobs.has(jobId)) {
      throw new Error(`Job ${jobId} not found`);
    }

    const dir = this.jobDir(jobId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.jobs.delete(jobId);
  }

  private jobDir(jobId: string): string {
    return within(this.baseDir, jobId);
  }

  private jobPath(jobId: string, ...segments: string[]): string {
    return within(this.jobDir(jobId), path.join(...segments));
  }

  private require(jobId: string): JobRecord {
    const record = this.jobs.get(jobId);
    if (!record) {
      throw new Error(`Job ${jobId} not found`);
    }
    return record;
  }

  private async writeJobRecord(jobId: string, job: JobRecord): Promise<void> {
    await writeFile(
      this.jobPath(jobId, "job.json"),
      JSON.stringify(job, null, 2),
      "utf8",
    );
  }

  private async collectArtifacts(jobId: string): Promise<ArtifactFile[]> {
    const root = this.outputDir(jobId);
    const collected: ArtifactFile[] = [];

    const walk = async (relative = ".") => {
      const currentDir = within(root, relative);
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        const relPath = relative === "."
          ? entry.name
          : path.join(relative, entry.name);
        const absolute = within(root, relPath);
        if (entry.isDirectory()) {
          await walk(relPath);
        } else if (entry.isFile()) {
          const info = await stat(absolute);
          collected.push({
            path: relPath.replace(/\\/g, "/"),
            size: info.size,
            mime: lookupMime(relPath),
          });
        }
      }
    };

    try {
      await walk(".");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    collected.sort((a, b) => a.path.localeCompare(b.path));
    return collected;
  }
}

const lookupMime = (filePath: string): string | null => {
  const { extname } = path;
  const extension = extname(filePath).toLowerCase();

  switch (extension) {
    case ".pdf":
      return "application/pdf";
    case ".zip":
      return "application/zip";
    case ".html":
    case ".htm":
      return "text/html";
    case ".json":
      return "application/json";
    default:
      return null;
  }
};

export const createJobStore = async (): Promise<JobStore> => {
  const store = new JobStore(config.workspaceDir);
  await store.init();
  return store;
};
