import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import unzipper from "unzipper";

const ensureDir = async (dir: string) => {
  await mkdir(dir, { recursive: true });
};

const ensureWithin = (baseDir: string, targetPath: string): string => {
  const resolved = path.resolve(baseDir, targetPath);
  const normalizedBase = path.resolve(baseDir);
  if (!resolved.startsWith(`${normalizedBase}${path.sep}`) && resolved !== normalizedBase) {
    throw new Error(`Archive entry escapes destination: ${targetPath}`);
  }
  return resolved;
};

export const extractZipArchive = async (archivePath: string, destination: string) => {
  await rm(destination, { recursive: true, force: true });
  await ensureDir(destination);

  const directory = await unzipper.Open.file(archivePath);

  for (const entry of directory.files) {
    const relativePath = entry.path.replace(/\\/g, "/");

    if (!relativePath || relativePath.startsWith("__MACOSX")) {
      continue;
    }

    const absolute = ensureWithin(destination, relativePath);

    if (entry.type === "Directory") {
      await ensureDir(absolute);
      continue;
    }

    await ensureDir(path.dirname(absolute));
    const stream = entry.stream();

    await pipeline(stream, createWriteStream(absolute, { mode: 0o644 }));
  }
};
