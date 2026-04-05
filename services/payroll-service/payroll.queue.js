const { Queue, Worker } = require("bullmq");
const {
  createTransactionService,
} = require("../transaction-service/transaction.service");
const { logError, logInfo } = require("../../shared/observability/logger");

function getRedisConnection() {
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

function toPublicBatch(batch) {
  return {
    batchId: batch.batchId,
    employerAccountId: batch.employerAccountId,
    sourceWalletId: batch.sourceWalletId,
    currency: batch.currency,
    status: batch.status,
    totalJobs: batch.totalJobs,
    completedJobs: batch.completedJobs,
    failedJobs: batch.failedJobs,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    errors: batch.errors,
  };
}

function createPayrollQueueManager({ dbPool }) {
  const transactionService = createTransactionService({ dbPool });
  const connection = getRedisConnection();
  const employers = new Map();
  const batches = new Map();

  async function processPayrollJob(job) {
    const transfer = await transactionService.createTransfer(
      {
        senderWalletId: job.data.sourceWalletId,
        receiverWalletId: job.data.employeeWalletId,
        amountMinor: job.data.amountMinor,
        currency: job.data.currency,
      },
      { "idempotency-key": job.data.idempotencyKey },
    );

    return {
      transferId: transfer.transferId,
      idempotentReplay: Boolean(transfer.idempotentReplay),
    };
  }

  function ensureEmployerQueue(employerAccountId) {
    const existing = employers.get(employerAccountId);
    if (existing) {
      return existing;
    }

    const queueName = `payroll:${employerAccountId}`;

    const queue = new Queue(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 500,
        },
        removeOnComplete: 2000,
        removeOnFail: 2000,
      },
    });

    const worker = new Worker(queueName, processPayrollJob, {
      connection,
      concurrency: 1,
    });

    worker.on("active", (job) => {
      const batch = batches.get(job.data.batchId);
      if (!batch) {
        return;
      }

      if (batch.status === "QUEUED") {
        batch.status = "PROCESSING";
        batch.updatedAt = new Date().toISOString();
      }
    });

    worker.on("completed", (job) => {
      const batch = batches.get(job.data.batchId);
      if (!batch) {
        return;
      }

      batch.completedJobs += 1;
      batch.updatedAt = new Date().toISOString();

      if (batch.completedJobs + batch.failedJobs >= batch.totalJobs) {
        batch.status = batch.failedJobs > 0 ? "PARTIAL_FAILED" : "COMPLETED";
      }
    });

    worker.on("failed", (job, error) => {
      const batch = batches.get(job?.data?.batchId);
      if (!batch) {
        return;
      }

      batch.failedJobs += 1;
      batch.updatedAt = new Date().toISOString();
      batch.errors.push({
        employeeWalletId: job.data.employeeWalletId,
        reason: error.message,
      });

      if (batch.completedJobs + batch.failedJobs >= batch.totalJobs) {
        batch.status = "PARTIAL_FAILED";
      }
    });

    worker.on("error", (error) => {
      logError({
        message: "payroll_worker_error",
        requestId: null,
        userId: null,
        transactionId: null,
        error: error.message,
        employerAccountId,
      });
    });

    const state = {
      queue,
      worker,
    };

    employers.set(employerAccountId, state);
    return state;
  }

  async function submitBatch(batch, jobs) {
    const state = ensureEmployerQueue(batch.employerAccountId);

    batches.set(batch.batchId, {
      ...batch,
      status: "QUEUED",
      completedJobs: 0,
      failedJobs: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      errors: [],
    });

    await Promise.all(
      jobs.map((job, index) =>
        state.queue.add("payroll-credit", job, {
          jobId: `${batch.batchId}:${index + 1}`,
        }),
      ),
    );

    logInfo({
      message: "payroll_batch_queued",
      requestId: null,
      userId: null,
      transactionId: null,
      batchId: batch.batchId,
      employerAccountId: batch.employerAccountId,
      jobs: jobs.length,
    });

    return toPublicBatch(batches.get(batch.batchId));
  }

  function getBatch(batchId) {
    const batch = batches.get(batchId);
    if (!batch) {
      return null;
    }

    return toPublicBatch(batch);
  }

  return {
    submitBatch,
    getBatch,
  };
}

module.exports = { createPayrollQueueManager };
