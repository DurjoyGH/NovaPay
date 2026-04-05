const cors = require("cors");
const express = require("express");
const { randomUUID } = require("crypto");
const {
  createAccountRouter,
} = require("./services/account-service/account.routes");
const { createFxRouter } = require("./services/fx-service/fx.routes");
const {
  createLedgerRouter,
} = require("./services/ledger-service/ledger.routes");
const {
  createTransactionRouter,
} = require("./services/transaction-service/transaction.routes");
const {
  metricsMiddleware,
  metricsHandler,
} = require("./shared/observability/metrics");
const { logInfo, logError } = require("./shared/observability/logger");

function createServer({ dbPool }) {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(metricsMiddleware);

  app.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    req.userId = req.headers["x-user-id"] || "anonymous";
    req.transactionId = req.headers["x-transaction-id"] || null;

    logInfo({
      message: "request_started",
      requestId: req.requestId,
      userId: req.userId,
      transactionId: req.transactionId,
      method: req.method,
      path: req.originalUrl,
    });

    res.on("finish", () => {
      logInfo({
        message: "request_finished",
        requestId: req.requestId,
        userId: req.userId,
        transactionId: req.transactionId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
      });
    });

    next();
  });

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

  app.get("/metrics", metricsHandler);

  app.use("/ledger", createLedgerRouter({ dbPool }));
  app.use("/accounts", createAccountRouter({ dbPool }));
  app.use("/fx", createFxRouter({ dbPool }));
  app.use("/transactions", createTransactionRouter({ dbPool }));

  app.use((error, req, res, next) => {
    const statusCode = error.statusCode || 500;
    const code = error.message || "INTERNAL_ERROR";

    logError({
      message: "request_failed",
      requestId: req.requestId,
      userId: req.userId,
      transactionId: req.transactionId,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      error: code,
    });

    res.status(statusCode).json({
      ok: false,
      error: code,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}

module.exports = { createServer };
