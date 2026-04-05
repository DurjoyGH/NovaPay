const express = require("express");
const { randomUUID } = require("crypto");
const { createTransactionService } = require("./transaction.service");

function createTransactionRouter({ dbPool }) {
  const router = express.Router();
  const transactionService = createTransactionService({ dbPool });

  router.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    next();
  });

  router.post("/transfers", async (req, res, next) => {
    try {
      if (!req.body) {
        return res.status(400).json({
          ok: false,
          error: "EMPTY_BODY",
          requestId: req.requestId,
        });
      }

      const idempotencyKey =
        req.headers["idempotency-key"] || req.headers["Idempotency-Key"];

      const transfer = await transactionService.createTransfer(req.body, {
        "idempotency-key": idempotencyKey,
      });

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

  router.get("/transfers/:transferId", async (req, res, next) => {
    try {
      const transfer = await transactionService.getTransferById(
        req.params.transferId,
      );

      res.status(200).json({
        ok: true,
        data: transfer,
        requestId: req.requestId,
      });
    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  router.get("/wallets/:walletId/transfers", async (req, res, next) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 50;

      const transfers = await transactionService.listTransfersByWallet(
        req.params.walletId,
        limit,
      );

      res.status(200).json({
        ok: true,
        data: transfers,
        requestId: req.requestId,
      });
    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  return router;
}

module.exports = { createTransactionRouter };
