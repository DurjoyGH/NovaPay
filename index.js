const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config();

const { dbConfig } = require("./shared/db/db.config");
const { createServer } = require("./server");

const port = Number(process.env.PORT || 3000);
const pool = new Pool(dbConfig);

async function start() {
  await pool.query("SELECT 1");

  const app = createServer({ dbPool: pool });

  const httpServer = app.listen(port, () => {
    console.log(`NovaPay server running on port ${port}`);
  });

  const shutdown = async () => {
    httpServer.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error({
    message: "Failed to start server",
    error: error.message,
    timestamp: new Date().toISOString(),
  });
  process.exit(1);
});
