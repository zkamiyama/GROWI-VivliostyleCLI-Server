"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const logger_1 = require("./logger");
const server_1 = require("./server");
const main = async () => {
    const { app } = await (0, server_1.createServer)();
    app.listen(config_1.config.port, () => {
        logger_1.logger.info("Vivliostyle CLI server listening", {
            port: config_1.config.port,
            workspaceDir: config_1.config.workspaceDir,
            concurrency: config_1.config.concurrency,
        });
    });
};
main().catch((error) => {
    logger_1.logger.error("Failed to start server", { error });
    process.exitCode = 1;
});
//# sourceMappingURL=index.js.map