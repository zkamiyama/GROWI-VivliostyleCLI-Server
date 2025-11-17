"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractZipArchive = void 0;
const node_fs_1 = require("node:fs");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const promises_2 = require("node:stream/promises");
const unzipper_1 = __importDefault(require("unzipper"));
const ensureDir = async (dir) => {
    await (0, promises_1.mkdir)(dir, { recursive: true });
};
const ensureWithin = (baseDir, targetPath) => {
    const resolved = node_path_1.default.resolve(baseDir, targetPath);
    const normalizedBase = node_path_1.default.resolve(baseDir);
    if (!resolved.startsWith(`${normalizedBase}${node_path_1.default.sep}`) && resolved !== normalizedBase) {
        throw new Error(`Archive entry escapes destination: ${targetPath}`);
    }
    return resolved;
};
const extractZipArchive = async (archivePath, destination) => {
    await (0, promises_1.rm)(destination, { recursive: true, force: true });
    await ensureDir(destination);
    const directory = await unzipper_1.default.Open.file(archivePath);
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
        await ensureDir(node_path_1.default.dirname(absolute));
        const stream = entry.stream();
        await (0, promises_2.pipeline)(stream, (0, node_fs_1.createWriteStream)(absolute, { mode: 0o644 }));
    }
};
exports.extractZipArchive = extractZipArchive;
//# sourceMappingURL=archive.js.map