const express = require("express");
const { randomUUID } = require("crypto");
const { createTransactionService } = require("./transaction.service");

function createInternationalTransferAliasRouter({ dbPool }) {
  const router = express.Router();
  const transactionService = createTransactionService({ dbPool });

  router.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    next();
  });

  router.post("/international", async (req, res, next) => {
    try {
      if (!req.body) {
        return res.status(400).json({
          ok: false,
          error: "EMPTY_BODY",
          requestId: req.requestId,
        });
      }

      if (!req.body.fxQuoteId) {
        return res.status(400).json({
          ok: false,
          error: "MISSING_FX_QUOTE_ID",
          requestId: req.requestId,
        });
      }

      const idempotencyKey =
        req.headers["idempotency-key"] || req.headers["Idempotency-Key"];

      const transfer = await transactionService.createTransfer(req.body, {
        "idempotency-key": idempotencyKey,
      });

      req.transactionId = transfer.transferId || req.transactionId;

      res.status(transfer.idempotentReplay ? 200 : 201).json({
        ok: true,
        data: transfer,
        requestId: req.requestId,
      });
    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  return router;
}

module.exports = { createInternationalTransferAliasRouter };
