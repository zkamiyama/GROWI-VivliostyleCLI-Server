import type { IncomingHttpHeaders } from "http";

export type JobStatus = "created" | "queued" | "running" | "succeeded" | "failed";

export interface CliOptionsInput {
  configPath?: string;
  entry?: string | string[];
  outputFile?: string;
  format?: string;
  timeoutSeconds?: number;
  additionalArgs?: string[];
  css?: string;
  // Vivliostyle CLI: --log-level <silent|info|verbose|debug>
  logLevel?: "silent" | "info" | "verbose" | "debug";
}

export interface JobMetadata extends Record<string, unknown> {
  requestedBy?: string;
  title?: string;
}

export interface JobRequestPayload {
  jobId?: string;
  sourceArchiveBase64: string;
  cliOptions?: CliOptionsInput;
  metadata?: JobMetadata;
}

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: JobMetadata;
  cliOptions: CliOptionsInput;
  artifact?: JobArtifactSummary;
  error?: JobError;
  logTail?: string[];
  headers?: IncomingHttpHeaders;
}

export interface JobArtifactSummary {
  primaryFile?: string | null;
  files: ArtifactFile[];
}

export interface ArtifactFile {
  path: string;
  size: number;
  mime?: string | null;
}

export interface JobError {
  message: string;
  stack?: string;
  code?: string;
  timedOut?: boolean;
}

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  details?: Record<string, unknown>;
}
