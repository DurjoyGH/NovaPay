const dotenv = require("dotenv");
const { Pool } = require("pg");
const { initTracing } = require("./shared/observability/tracing");
const { logInfo, logError } = require("./shared/observability/logger");

dotenv.config();

const { dbConfig } = require("./shared/db/db.config");
const { createServer } = require("./server");

const port = Number(process.env.PORT || 3000);
const pool = new Pool(dbConfig);
let tracingSdk = null;

async function start() {
  tracingSdk = await initTracing();
  await pool.query("SELECT 1");

  const app = createServer({ dbPool: pool });

  const httpServer = app.listen(port, () => {
    logInfo({
      message: "server_started",
      requestId: null,
      userId: null,
      transactionId: null,
      port,
    });
  });

  const shutdown = async () => {
    httpServer.close(async () => {
      if (tracingSdk) {
        await tracingSdk.shutdown();
      }
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  logError({
    message: "server_start_failed",
    requestId: null,
    userId: null,
    transactionId: null,
    error: error.message,
  });
  process.exit(1);
});
