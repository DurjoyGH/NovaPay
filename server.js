const cors = require("cors");
const express = require("express");

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

  return app;
}

module.exports = { createServer };
