const { randomUUID } = require("crypto");
const { createPayrollQueueManager } = require("./payroll.queue");

function isUUID(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function normalizeCurrency(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const normalized = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function createError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function createPayrollService({ dbPool }) {
  const queueManager = createPayrollQueueManager({ dbPool });

  async function createBatch(payload) {
    if (!payload || typeof payload !== "object") {
      throw createError("INVALID_INPUT");
    }

    if (!isUUID(payload.employerAccountId)) {
      throw createError("INVALID_EMPLOYER_ACCOUNT_ID");
    }

    if (!isUUID(payload.sourceWalletId)) {
      throw createError("INVALID_SOURCE_WALLET_ID");
    }

    const currency = normalizeCurrency(payload.currency);
    if (!currency) {
      throw createError("INVALID_CURRENCY");
    }

    if (!Array.isArray(payload.items) || payload.items.length === 0) {
      throw createError("INVALID_PAYROLL_ITEMS");
    }

    if (payload.items.length > 14000) {
      throw createError("PAYROLL_BATCH_TOO_LARGE");
    }

    const batchId = randomUUID();
    const jobs = payload.items.map((item, index) => {
      if (!item || typeof item !== "object") {
        throw createError("INVALID_PAYROLL_ITEM");
      }

      if (!isUUID(item.employeeWalletId)) {
        throw createError("INVALID_EMPLOYEE_WALLET_ID");
      }

      if (item.employeeWalletId === payload.sourceWalletId) {
        throw createError("SOURCE_AND_DESTINATION_WALLET_SAME");
      }

      const amountMinor = Number(item.amountMinor);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        throw createError("INVALID_AMOUNT");
      }

      const idempotencyKey =
        typeof item.idempotencyKey === "string" && item.idempotencyKey.trim()
          ? item.idempotencyKey.trim()
          : `payroll-${payload.employerAccountId}-${batchId}-${index + 1}`;

      return {
        batchId,
        employerAccountId: payload.employerAccountId,
        sourceWalletId: payload.sourceWalletId,
        employeeWalletId: item.employeeWalletId,
        amountMinor,
        currency,
        idempotencyKey,
      };
    });

    return queueManager.submitBatch(
      {
        batchId,
        employerAccountId: payload.employerAccountId,
        sourceWalletId: payload.sourceWalletId,
        currency,
        totalJobs: jobs.length,
      },
      jobs,
    );
  }

  function getBatchById(batchId) {
    if (!isUUID(batchId)) {
      throw createError("INVALID_BATCH_ID");
    }

    const batch = queueManager.getBatch(batchId);
    if (!batch) {
      throw createError("PAYROLL_BATCH_NOT_FOUND", 404);
    }

    return batch;
  }

  return {
    createBatch,
    getBatchById,
  };
}

module.exports = { createPayrollService };
