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

  // Additional args come before our defaults so explicit user-provided
  // flags can be detected and respected below (e.g., --log-level).
  if (opts.additionalArgs?.length) {
    args.push(...opts.additionalArgs);
  }

  if (typeof opts.css === "string" && opts.css.length > 0) {
    args.push("--css", opts.css);
  }

  // Apply log level: default to 'debug' when frontend did not specify.
  const hasLogLevelInAdditional = (opts.additionalArgs ?? []).some(
    (a) => a === "--log-level" || a.startsWith("--log-level=")
  );
  if (opts.logLevel) {
    args.push("--log-level", opts.logLevel);
  } else if (!hasLogLevelInAdditional) {
    args.push("--log-level", "debug");
  }

  // Disable internal static file serving by default so Vivliostyle
  // loads files from the local workspace instead of translating
  // relative paths to /vivliostyle/ HTTP URLs which can lead to 404s.
  // Users can override by passing explicit additionalArgs.
  args.push("--no-enable-static-serve");

  const entries = Array.isArray(opts.entry) ? opts.entry : (opts.entry ? [opts.entry] : []);
  args.push(...entries);

  return args;
};

type LogLevel = LogEntry["level"];

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

const VIVLIOSTYLE_LEVEL_MAP: Record<string, LogLevel> = {
  ERROR: "error",
  WARN: "warn",
  WARNING: "warn",
  INFO: "info",
  SUCCESS: "info",
  DEBUG: "debug",
};

interface AnalyzedLine {
  level: LogLevel;
  message: string;
  matched: boolean;
  sourceTimestamp?: string;
}

const analyzeVivliostyleLine = (line: string, fallbackLevel: LogLevel): AnalyzedLine => {
  const match = line.match(
    /^((?<timestamp>\d{4}-\d{2}-\d{2}T[^\s]+)\s+)?vs-cli\s+(?<payload>.*)$/i,
  );
  if (!match) {
    return { level: fallbackLevel, message: line, matched: false };
  }

  const payload = (match.groups?.payload ?? "").trimStart();
  const upperPayload = payload.toUpperCase();

  for (const token of Object.keys(VIVLIOSTYLE_LEVEL_MAP)) {
    if (
      upperPayload.startsWith(`${token} `) ||
      upperPayload.startsWith(`${token}:`) ||
      upperPayload === token
    ) {
      return {
        level: VIVLIOSTYLE_LEVEL_MAP[token],
        message: line,
        matched: true,
        sourceTimestamp: match.groups?.timestamp,
      };
    }
  }

  return {
    level: "debug",
    message: line,
    matched: true,
    sourceTimestamp: match.groups?.timestamp,
  };
};

const createLogStreamProcessor = (
  fallbackLevel: LogLevel,
  appendLog: RunVivliostyleOptions["appendLog"],
) => {
  let buffer = "";
  let pending:
    | {
        level: LogLevel;
        lines: string[];
        sourceTimestamp?: string;
      }
    | undefined;

  const flushPending = async () => {
    if (!pending || pending.lines.length === 0) {
      pending = undefined;
      return;
    }
    let timestamp = new Date().toISOString();
    if (pending.sourceTimestamp) {
      const parsed = Date.parse(pending.sourceTimestamp);
      if (!Number.isNaN(parsed)) {
        timestamp = new Date(parsed).toISOString();
      }
    }
    await appendLog({
      timestamp,
      level: pending.level,
      message: pending.lines.join("\n"),
    });
    pending = undefined;
  };

  const handleLine = async (rawLine: string) => {
    const sanitized = stripAnsi(rawLine);
    if (sanitized.trim().length === 0) {
      if (pending) {
        pending.lines.push("");
      }
      return;
    }
    const analyzed = analyzeVivliostyleLine(sanitized, fallbackLevel);

    if (analyzed.matched) {
      await flushPending();
      pending = {
        level: analyzed.level,
        lines: [analyzed.message],
        sourceTimestamp: analyzed.sourceTimestamp,
      };
      return;
    }

    if (!pending) {
      pending = { level: analyzed.level, lines: [] };
    }
    pending.lines.push(analyzed.message);
  };

  const processBuffer = async (text: string) => {
    buffer += text;
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      await handleLine(part);
    }
  };

  return {
    push: async (chunk: Buffer) => {
      await processBuffer(chunk.toString("utf8"));
    },
    flush: async () => {
      if (buffer.length > 0) {
        await handleLine(buffer);
        buffer = "";
      }
      await flushPending();
    },
  };
};

export const runVivliostyle = async (
  options: RunVivliostyleOptions,
): Promise<VivliostyleRunResult> => {
  const args = buildArguments(options.cliOptions);
  const logPrefix = `[Job ${options.jobId}]`;
  logger.info(`${logPrefix} starting Vivliostyle CLI`, { args });

  let timedOut = false;
  const stdoutProcessor = createLogStreamProcessor("info", options.appendLog);
  const stderrProcessor = createLogStreamProcessor("error", options.appendLog);
  const child = spawn(process.execPath, [CLI_BIN, ...args], {
    cwd: options.workspaceDir,
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "production",
    },
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    void stdoutProcessor.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    void stderrProcessor.push(chunk);
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
      void stdoutProcessor.flush();
      void stderrProcessor.flush();
      reject(error);
    });

    child.once("close", async (code, signal) => {
      timeoutController?.abort();
      try {
        await stdoutProcessor.flush();
        await stderrProcessor.flush();
      } catch (flushError) {
        logger.warn(`${logPrefix} failed to flush Vivliostyle log streams`, {
          error: (flushError as Error).message,
        });
      }
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
