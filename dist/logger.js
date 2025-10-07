"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const emit = (level, message, details) => {
    const payload = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...(details ? { details } : {}),
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
        console.error(line);
    }
    else if (level === "warn") {
        console.warn(line);
    }
    else {
        console.log(line);
    }
};
exports.logger = {
    info: (message, details) => emit("info", message, details),
    warn: (message, details) => emit("warn", message, details),
    error: (message, details) => emit("error", message, details),
    debug: (message, details) => emit("debug", message, details),
};
//# sourceMappingURL=logger.js.map