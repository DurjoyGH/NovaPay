const express = require("express");
const { randomUUID } = require("crypto");
const { createPayrollService } = require("./payroll.service");

function createPayrollRouter({ dbPool }) {
  const router = express.Router();
  const payrollService = createPayrollService({ dbPool });

  router.use((req, res, next) => {
    req.requestId = req.headers["x-request-id"] || randomUUID();
    next();
  });

  router.post("/batches", async (req, res, next) => {
    try {
      if (!req.body) {
        return res.status(400).json({
          ok: false,
          error: "EMPTY_BODY",
          requestId: req.requestId,
        });
      }

      const batch = await payrollService.createBatch(req.body);

      res.status(202).json({
        ok: true,
        data: batch,
        requestId: req.requestId,
      });
    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  router.get("/batches/:batchId", async (req, res, next) => {
    try {
      const batch = await payrollService.getBatchById(req.params.batchId);

      res.status(200).json({
        ok: true,
        data: batch,
        requestId: req.requestId,
      });
    } catch (error) {
      error.requestId = req.requestId;
      next(error);
    }
  });

  return router;
}

module.exports = { createPayrollRouter };
