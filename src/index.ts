import { config } from "./config";
import { logger } from "./logger";
import { createServer } from "./server";

const main = async () => {
  const { app } = await createServer();

  app.listen(config.port, () => {
    logger.info("Vivliostyle CLI server listening", {
      port: config.port,
      workspaceDir: config.workspaceDir,
      concurrency: config.concurrency,
    });
  });
};

main().catch((error) => {
  logger.error("Failed to start server", { error });
  process.exitCode = 1;
});
