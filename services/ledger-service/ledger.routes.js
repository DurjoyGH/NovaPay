const express = require("express");
const { randomUUID } = require("crypto");
const { createLedgerService } = require("./ledger.service");

function createLedgerRouter({ dbPool }) {
  const router = express.Router();
  const ledgerService = createLedgerService({ dbPool });

  router.post("/transfers", async (req, res, next) => {
    const requestId = req.headers["x-request-id"] || randomUUID();

    try {
      if (!req.body) {
        return res.status(400).json({
          ok: false,
          error: "EMPTY_BODY",
          requestId,
        });
      }

      const transfer = await ledgerService.createTransfer(req.body);

      const statusCode = transfer.idempotentReplay ? 200 : 201;

      res.status(statusCode).json({
        ok: true,
        data: transfer,
        requestId,
      });
    } catch (error) {
      error.requestId = requestId;
      next(error);
    }
  });

  return router;
}

module.exports = { createLedgerRouter };
