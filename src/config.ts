import path from "node:path";

const DEFAULT_PORT = 4781;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_ARCHIVE_MB = 50;
const DEFAULT_CLI_TIMEOUT_MS = 600_000;

const numberFromEnv = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: numberFromEnv(process.env.PORT, DEFAULT_PORT),
  concurrency: numberFromEnv(process.env.VIV_QUEUE_CONCURRENCY, DEFAULT_CONCURRENCY),
  workspaceDir: path.resolve(
    process.env.VIV_WORKSPACE_DIR ?? path.join(process.cwd(), "jobs"),
  ),
  maxArchiveBytes:
    numberFromEnv(process.env.VIV_MAX_ARCHIVE_SIZE_MB, DEFAULT_MAX_ARCHIVE_MB) *
    1024 *
    1024,
  cliTimeoutMs: numberFromEnv(
    process.env.VIV_CLI_TIMEOUT_MS,
    DEFAULT_CLI_TIMEOUT_MS,
  ),
};

export type ServiceConfig = typeof config;
