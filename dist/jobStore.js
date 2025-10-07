"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJobStore = exports.JobStore = void 0;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const LOG_TAIL_LENGTH = 50;
const ensureTrailingSep = (value) => value.endsWith(node_path_1.default.sep) ? value : `${value}${node_path_1.default.sep}`;
const within = (base, target) => {
    const baseResolved = node_path_1.default.resolve(base);
    const resolved = node_path_1.default.resolve(baseResolved, target);
    const normalizedBase = ensureTrailingSep(baseResolved);
    if (resolved === baseResolved) {
        return resolved;
    }
    if (!resolved.startsWith(normalizedBase)) {
        throw new Error(`Path escapes workspace: ${target}`);
    }
    return resolved;
};
const now = () => new Date().toISOString();
class JobStore {
    baseDir;
    jobs = new Map();
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    async init() {
        await (0, promises_1.mkdir)(this.baseDir, { recursive: true });
        const entries = await (0, promises_1.readdir)(this.baseDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const jobId = entry.name;
            const jobRecordPath = this.jobPath(jobId, "job.json");
            try {
                const json = await (0, promises_1.readFile)(jobRecordPath, "utf8");
                const data = JSON.parse(json);
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
            }
            catch (error) {
                // eslint-disable-next-line no-console
                console.error(`[JobStore] failed to load record for job ${jobId}:`, error);
            }
        }
    }
    listJobs() {
        return [...this.jobs.values()].sort((a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf());
    }
    get(jobId) {
        return this.jobs.get(jobId);
    }
    async create(job, opts) {
        if (this.jobs.has(job.jobId)) {
            throw new Error(`Job ${job.jobId} already exists`);
        }
        const dir = this.jobDir(job.jobId);
        await (0, promises_1.mkdir)(dir, { recursive: false });
        await (0, promises_1.mkdir)(this.workspaceDir(job.jobId), { recursive: true });
        await (0, promises_1.mkdir)(this.outputDir(job.jobId), { recursive: true });
        const snapshot = {
            jobId: job.jobId,
            cliOptions: job.cliOptions,
            metadata: job.metadata ?? {},
            ...opts.requestSnapshot,
        };
        await (0, promises_1.writeFile)(this.jobPath(job.jobId, "request.json"), JSON.stringify(snapshot, null, 2), "utf8");
        await (0, promises_1.writeFile)(this.jobPath(job.jobId, "source.zip"), opts.archiveBuffer);
        this.jobs.set(job.jobId, job);
        await this.writeJobRecord(job.jobId, job);
        return job;
    }
    async update(jobId, patch) {
        const current = this.require(jobId);
        const next = {
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
    async markStatus(jobId, status) {
        const current = this.require(jobId);
        const patch = { status };
        if (status === "queued") {
            patch.queuedAt = now();
        }
        else if (status === "running") {
            patch.startedAt = now();
        }
        else if (status === "succeeded" || status === "failed") {
            patch.completedAt = now();
        }
        return this.update(jobId, patch);
    }
    async recordError(jobId, error) {
        return this.update(jobId, {
            status: "failed",
            error,
            completedAt: now(),
        });
    }
    async recordArtifactManifest(jobId) {
        const files = await this.collectArtifacts(jobId);
        const primary = files.find((file) => file.path === this.require(jobId).artifact?.primaryFile)
            ?.path ??
            files.find((file) => file.path.endsWith(".pdf"))?.path ??
            files[0]?.path ??
            null;
        const summary = {
            primaryFile: primary,
            files,
        };
        await this.update(jobId, { artifact: summary });
        return summary;
    }
    async appendLog(jobId, entry) {
        const line = JSON.stringify(entry);
        await (0, promises_1.appendFile)(this.jobPath(jobId, "log.ndjson"), `${line}\n`, "utf8");
    }
    async readLog(jobId) {
        try {
            return await (0, promises_1.readFile)(this.jobPath(jobId, "log.ndjson"), "utf8");
        }
        catch {
            return "";
        }
    }
    async readLogTail(jobId, limit = LOG_TAIL_LENGTH) {
        const content = await this.readLog(jobId);
        if (!content) {
            return [];
        }
        const lines = content.split(/\r?\n/).filter(Boolean);
        return lines.slice(-limit);
    }
    getArchivePath(jobId) {
        return this.jobPath(jobId, "source.zip");
    }
    workspaceDir(jobId) {
        return this.jobPath(jobId, "workspace");
    }
    outputDir(jobId) {
        return this.jobPath(jobId, "output");
    }
    logPath(jobId) {
        return this.jobPath(jobId, "log.ndjson");
    }
    artifactFileAbsolutePath(jobId, relative) {
        return within(this.outputDir(jobId), relative);
    }
    artifactFileExists(jobId, relative) {
        const target = this.artifactFileAbsolutePath(jobId, relative);
        return (0, promises_1.stat)(target)
            .then((info) => info.isFile())
            .catch(() => false);
    }
    createArtifactReadStream(jobId, relative) {
        const target = this.artifactFileAbsolutePath(jobId, relative);
        return (0, node_fs_1.createReadStream)(target);
    }
    createLogReadStream(jobId) {
        return (0, node_fs_1.createReadStream)(this.logPath(jobId));
    }
    async cleanupInput(jobId) {
        const targets = [
            this.getArchivePath(jobId),
            this.workspaceDir(jobId),
        ];
        await Promise.allSettled(targets.map(async (target) => {
            await (0, promises_1.rm)(target, { recursive: true, force: true });
        }));
    }
    async deleteJob(jobId) {
        if (!this.jobs.has(jobId)) {
            throw new Error(`Job ${jobId} not found`);
        }
        const dir = this.jobDir(jobId);
        try {
            await (0, promises_1.rm)(dir, { recursive: true, force: true });
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
        this.jobs.delete(jobId);
    }
    jobDir(jobId) {
        return within(this.baseDir, jobId);
    }
    jobPath(jobId, ...segments) {
        return within(this.jobDir(jobId), node_path_1.default.join(...segments));
    }
    require(jobId) {
        const record = this.jobs.get(jobId);
        if (!record) {
            throw new Error(`Job ${jobId} not found`);
        }
        return record;
    }
    async writeJobRecord(jobId, job) {
        await (0, promises_1.writeFile)(this.jobPath(jobId, "job.json"), JSON.stringify(job, null, 2), "utf8");
    }
    async collectArtifacts(jobId) {
        const root = this.outputDir(jobId);
        const collected = [];
        const walk = async (relative = ".") => {
            const currentDir = within(root, relative);
            const entries = await (0, promises_1.readdir)(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.name.startsWith(".")) {
                    continue;
                }
                const relPath = relative === "."
                    ? entry.name
                    : node_path_1.default.join(relative, entry.name);
                const absolute = within(root, relPath);
                if (entry.isDirectory()) {
                    await walk(relPath);
                }
                else if (entry.isFile()) {
                    const info = await (0, promises_1.stat)(absolute);
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
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            throw error;
        }
        collected.sort((a, b) => a.path.localeCompare(b.path));
        return collected;
    }
}
exports.JobStore = JobStore;
const lookupMime = (filePath) => {
    const { extname } = node_path_1.default;
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
const createJobStore = async () => {
    const store = new JobStore(config_1.config.workspaceDir);
    await store.init();
    return store;
};
exports.createJobStore = createJobStore;
//# sourceMappingURL=jobStore.js.map