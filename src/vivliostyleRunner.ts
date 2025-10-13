import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { config } from "./config";
import { logger } from "./logger";
import type { CliOptionsInput, LogEntry } from "./types";

interface RunVivliostyleOptions {
  jobId: string;
  workspaceDir: string;
  cliOptions: CliOptionsInput;
  appendLog: (entry: LogEntry) => Promise<void>;
}

export interface VivliostyleRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  args: string[];
}

const CLI_BIN = resolveCliBinary();

const buildArguments = (opts: CliOptionsInput): string[] => {
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

const streamToLog = async (
  chunk: Buffer,
  level: LogEntry["level"],
  appendLog: RunVivliostyleOptions["appendLog"],
) => {
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

export const runVivliostyle = async (
  options: RunVivliostyleOptions,
): Promise<VivliostyleRunResult> => {
  const args = buildArguments(options.cliOptions);
  const logPrefix = `[Job ${options.jobId}]`;
  logger.info(`${logPrefix} starting Vivliostyle CLI`, { args });

  let timedOut = false;
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    cwd: options.workspaceDir,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    void streamToLog(chunk, "info", options.appendLog);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    void streamToLog(chunk, "error", options.appendLog);
  });

  const timeout = config.cliTimeoutMs;

  let timeoutController: AbortController | undefined;

  if (timeout > 0 && Number.isFinite(timeout)) {
    timeoutController = new AbortController();
    const { signal } = timeoutController;
    void (async () => {
      try {
        await delay(timeout, undefined, { signal });
        timedOut = true;
        logger.warn(`${logPrefix} Vivliostyle CLI timed out after ${timeout}ms`);
        child.kill("SIGTERM");
        await delay(1_000);
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          logger.error(`${logPrefix} timeout controller error`, { error });
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
      logger.info(`${logPrefix} finished Vivliostyle CLI`, { code, signal });
      resolve({
        exitCode: code,
        signal,
        timedOut,
        args,
      });
    });
  });
};

function resolveCliBinary(): string {
  const pkgPath = require.resolve("@vivliostyle/cli/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  let binRelative: string | undefined;
  if (typeof pkg.bin === "string") {
    binRelative = pkg.bin;
  } else if (pkg.bin && typeof pkg.bin === "object") {
    binRelative = pkg.bin.vivliostyle ?? Object.values(pkg.bin)[0];
  }
  if (!binRelative) {
    throw new Error("Unable to resolve Vivliostyle CLI binary");
  }
  return path.resolve(path.dirname(pkgPath), binRelative);
}
