const cors = require("cors");
const express = require("express");
const { createAccountRouter } = require("./services/account-service/account.routes");
const { createLedgerRouter } = require("./services/ledger-service/ledger.routes");

function createServer({ dbPool }) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.status(200).json({
      ok: true,
      service: "novapay",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health/db", async (req, res) => {
    try {
      await dbPool.query("SELECT 1");
      res.status(200).json({
        ok: true,
        database: "connected",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        ok: false,
        database: "disconnected",
        error: "DB_UNAVAILABLE",
      });
    }
  });

  app.use("/ledger", createLedgerRouter({ dbPool }));
  app.use("/accounts", createAccountRouter({ dbPool }));

  app.use((error, req, res, next) => {
    const statusCode = error.statusCode || 500;
    const code = error.message || "INTERNAL_ERROR";

    res.status(statusCode).json({
      ok: false,
      error: code,
      timestamp: new Date().toISOString()
    });
  });

  return app;
}

module.exports = { createServer };
