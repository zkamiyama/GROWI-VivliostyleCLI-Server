import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtemp, rm, mkdir, writeFile, stat } from "node:fs/promises";
import type { ServiceConfig } from "../src/config";

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
  let httpServer: http.Server | undefined;
  let runtimeConfig: ServiceConfig;
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
    workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vivlio-test-"));
    cleanupDirs.push(workspaceDir);
    process.env.VIV_WORKSPACE_DIR = workspaceDir;
    process.env.VIV_QUEUE_CONCURRENCY = "1";
    ({ createServer } = await import("../src/server"));
    runtimeConfig = (await import("../src/config")).config;
    runtimeConfig.autoCleanupTimeoutMs = 0;
    runtimeConfig.frontendPingUrl = "";
  });

  afterEach(async () => {
    if (serverBundle) {
      await serverBundle.queue.onIdle();
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = undefined;
    }
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      await rm(dir, { recursive: true, force: true });
    }
    runtimeConfig.autoCleanupTimeoutMs = 0;
    runtimeConfig.frontendPingUrl = "";
    vi.useRealTimers();
    serverBundle = undefined;
  });

  it("accepts a job submission and runs Vivliostyle runner", async () => {
    serverBundle = await createServer();
    const { app, queue } = serverBundle;

    const postResponse = await request(app)
      .post("/vivliostyle/jobs")
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
      .get(`/vivliostyle/jobs/${jobId}`)
      .expect(200);

    expect(statusResponse.body.status).toBe("succeeded");
    expect(statusResponse.body.artifact.primaryFile).toBe("artifacts/book.pdf");

    const jobDir = path.join(workspaceDir, jobId);
    const outputStat = await stat(path.join(jobDir, "output", "artifacts", "book.pdf"));
    expect(outputStat.isFile()).toBe(true);

    await expect(stat(path.join(jobDir, "source.zip"))).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(path.join(jobDir, "workspace"))).rejects.toHaveProperty("code", "ENOENT");

    await request(app)
      .delete(`/vivliostyle/jobs/${jobId}`)
      .expect(204);

    await expect(stat(jobDir)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("accepts multipart form submission for vivliostyle jobs", async () => {
    serverBundle = await createServer();
    const { app, queue } = serverBundle;

    const pageId = "page:123";
    const response = await request(app)
      .post("/vivliostyle/jobs")
      .field("pageId", pageId)
      .field("pagePath", "/docs/sample")
      .field("title", "Multipart Job")
      .attach("zip", Buffer.from("zip"), { filename: "book.zip", contentType: "application/zip" })
      .expect(202);

    expect(response.body.jobId).toBeDefined();
    const jobId: string = response.body.jobId;
    expect(jobId).toBe("page-123");

    await queue.onIdle();

    const status = await request(app)
      .get(`/vivliostyle/jobs/${jobId}`)
      .expect(200);

    expect(status.body.status).toBe("succeeded");
    expect(status.body.metadata.pageId).toBe(pageId);
    expect(status.body.metadata.pagePath).toBe("/docs/sample");
    expect(status.body.metadata.source).toBe("multipart-form");
    expect(status.body.metadata.title).toBe("Multipart Job");
  });

  it("streams logs via SSE endpoint and closes on completion", async () => {
    serverBundle = await createServer();
    const { app, queue } = serverBundle;

    httpServer = http.createServer(app);
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const createResponse = await request(httpServer)
      .post("/vivliostyle/jobs")
      .send({
        sourceArchive: encode("zip"),
        metadata: { title: "SSE Sample" },
      })
      .expect(202);

    const jobId: string = createResponse.body.jobId;

    await queue.onIdle();

    const sseData = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/vivliostyle/jobs/${jobId}/log/stream`,
        {
          method: "GET",
          headers: { Accept: "text/event-stream" },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString("utf8");
          });
          res.on("end", () => resolve(data));
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(sseData).toContain("Job started");
    expect(sseData).toContain("event: status");
    expect(sseData).toContain("\"status\":\"succeeded\"");
    expect(sseData).toContain("event: complete");
  });

  it("rejects invalid archives", async () => {
    serverBundle = await createServer();
    const { app } = serverBundle;

    const response = await request(app)
      .post("/vivliostyle/jobs")
      .send({
        sourceArchive: "%%%invalid%%%",
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid_base64");
  });

  it("cleans up job directory automatically when delete is not called", async () => {
    runtimeConfig.autoCleanupTimeoutMs = 200;

    serverBundle = await createServer();
    const { app, queue, store } = serverBundle;

    const postResponse = await request(app)
      .post("/vivliostyle/jobs")
      .send({
        sourceArchive: encode("zip"),
        metadata: { title: "Auto Cleanup" },
      })
      .expect(202);

    const jobId: string = postResponse.body.jobId;

    await queue.onIdle();

    const jobDir = path.join(workspaceDir, jobId);
    const jobDirStat = await stat(jobDir);
    expect(jobDirStat.isDirectory()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(stat(jobDir)).rejects.toHaveProperty("code", "ENOENT");
    expect(store.get(jobId)).toBeUndefined();
  });
});





