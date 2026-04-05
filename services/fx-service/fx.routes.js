const express = require("express");
const { randomUUID } = require("crypto");
const { createFxService } = require("./fx.service");
const { logInfo } = require("../../shared/observability/logger");

function createFxRouter({ dbPool }) {
  const router = express.Router();
  const fxService = createFxService({ dbPool });

  router.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    next();
  });

  router.post("/quote", async (req, res, next) => {
    try {
      logInfo({
        message: "fx_quote_issue",
        requestId: req.requestId,
        userId: req.headers["x-user-id"] || "anonymous",
        transactionId: req.headers["x-transaction-id"] || null,
        route: req.originalUrl,
        method: req.method
      });

      if (!req.is("application/json")) {
        return res.status(415).json({
          ok: false,
          error: "UNSUPPORTED_MEDIA_TYPE",
          requestId: req.requestId,
        });
      }

      if (!req.body) {
        return res.status(400).json({
          ok: false,
          error: "EMPTY_BODY",
          requestId: req.requestId,
        });
      }

      const quote = await fxService.issueQuote(req.body);

      res.set("Cache-Control", "no-store");

      res.status(201).json({
        ok: true,
        data: quote,
        requestId: req.requestId,
      });
    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  router.get("/quote/:quoteId", async (req, res, next) => {
    try {
      logInfo({
        message: "fx_quote_get",
        requestId: req.requestId,
        userId: req.headers["x-user-id"] || "anonymous",
        transactionId: req.headers["x-transaction-id"] || null,
        route: req.originalUrl,
        method: req.method
      });

      const quote = await fxService.getQuote(req.params.quoteId);

      res.set("Cache-Control", "no-store");

      res.status(200).json({
        ok: true,
        data: quote,
        requestId: req.requestId,
      });
    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  return router;
}

module.exports = { createFxRouter };
