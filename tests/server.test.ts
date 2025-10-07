import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";

const fsForMock = { mkdir, writeFile };
const pathForMock = path;

vi.mock("../src/archive", () => ({
  extractZipArchive: vi.fn(async () => {}),
}));

vi.mock("../src/vivliostyleRunner", () => ({
  runVivliostyle: vi.fn(async ({ cliOptions }) => {
    if (cliOptions.outputFile) {
      await fsForMock.mkdir(pathForMock.dirname(cliOptions.outputFile), { recursive: true });
      await fsForMock.writeFile(cliOptions.outputFile, "dummy-pdf");
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      args: ["build"],
    };
  }),
}));

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");

describe("Vivliostyle job API", () => {
  const originalEnv = { ...process.env };
  let workspaceDir: string;
  let createServer: typeof import("../src/server").createServer;
  let serverBundle: Awaited<ReturnType<typeof import("../src/server").createServer>> | undefined;
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vivlio-test-"));
    cleanupDirs.push(workspaceDir);
    process.env.VIV_WORKSPACE_DIR = workspaceDir;
    process.env.VIV_QUEUE_CONCURRENCY = "1";
    ({ createServer } = await import("../src/server"));
  });

  afterEach(async () => {
    if (serverBundle) {
      await serverBundle.queue.onIdle();
    }
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      await rm(dir, { recursive: true, force: true });
    }
    serverBundle = undefined;
  });

  it("accepts a job submission and runs Vivliostyle runner", async () => {
    serverBundle = await createServer();
    const { app, queue } = serverBundle;

    const postResponse = await request(app)
      .post("/api/v1/jobs")
      .send({
        sourceArchive: encode("zip"),
        cliOptions: { outputFile: "artifacts/book.pdf" },
        metadata: { title: "Sample" },
      })
      .expect(202);

    expect(postResponse.body.jobId).toBeDefined();
    const jobId: string = postResponse.body.jobId;

    await queue.onIdle();

    const statusResponse = await request(app)
      .get(`/api/v1/jobs/${jobId}`)
      .expect(200);

    expect(statusResponse.body.status).toBe("succeeded");
    expect(statusResponse.body.artifact.primaryFile).toBe("artifacts/book.pdf");

    const jobDir = path.join(workspaceDir, jobId);
    const outputStat = await stat(path.join(jobDir, "output", "artifacts", "book.pdf"));
    expect(outputStat.isFile()).toBe(true);

    await expect(stat(path.join(jobDir, "source.zip"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(path.join(jobDir, "workspace"))).rejects.toHaveProperty("code", "ENOENT");

    await request(app)
      .delete(`/api/v1/jobs/${jobId}`)
      .expect(204);

    await expect(stat(jobDir)).rejects.toHaveProperty("code", "ENOENT");

    await request(app)
      .get(`/api/v1/jobs/${jobId}`)
      .expect(404);
  });

  it("rejects invalid archives", async () => {
    serverBundle = await createServer();
    const { app } = serverBundle;

    const response = await request(app)
      .post("/api/v1/jobs")
      .send({
        sourceArchive: "%%%invalid%%%",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_base64");
  });
});
