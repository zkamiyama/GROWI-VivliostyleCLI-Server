type LogLevel = "info" | "warn" | "error" | "debug";

interface LogDetails {
  [key: string]: unknown;
}

const emit = (level: LogLevel, message: string, details?: LogDetails) => {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(details ? { details } : {}),
  };
  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
};

export const logger = {
  info: (message: string, details?: LogDetails) => emit("info", message, details),
  warn: (message: string, details?: LogDetails) => emit("warn", message, details),
  error: (message: string, details?: LogDetails) => emit("error", message, details),
  debug: (message: string, details?: LogDetails) => emit("debug", message, details),
};

export type { LogLevel, LogDetails };
