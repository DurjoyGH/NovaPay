const express = require("express");
const { randomUUID } = require("crypto");
const { createAccountService } = require("./account.service");

function createAccountRouter({ dbPool }) {
  const router = express.Router();
  const accountService = createAccountService({ dbPool });
  
  router.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    next();
  });

  router.post("/wallets", async (req, res, next) => {
    try {
      if (!req.body) {
        return res.status(400).json({
          ok: false,
          error: "EMPTY_BODY",
          requestId: req.requestId
        });
      }

      const wallet = await accountService.createWallet(req.body);

      res.status(201).json({
        ok: true,
        data: wallet,
        requestId: req.requestId
      });

    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  router.get("/wallets/:walletId", async (req, res, next) => {
    try {
      const wallet = await accountService.getWalletById(req.params.walletId);

      res.status(200).json({
        ok: true,
        data: wallet,
        requestId: req.requestId
      });

    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  router.get("/users/:userId/wallets", async (req, res, next) => {
    try {
      const wallets = await accountService.listUserWallets(req.params.userId);

      res.status(200).json({
        ok: true,
        data: wallets,
        requestId: req.requestId
      });

    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  return router;
}

module.exports = { createAccountRouter };