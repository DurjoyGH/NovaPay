const { createLedgerService } = require("../ledger-service/ledger.service");

function isUUID(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function createError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function toInt(value) {
  return parseInt(value, 10);
}

function toPublicTransfer(row) {
  return {
    transferId: row.transfer_id,
    idempotencyKey: row.idempotency_key,
    senderWalletId: row.sender_wallet_id,
    receiverWalletId: row.receiver_wallet_id,
    amountMinor: toInt(row.amount_minor),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    fxQuoteId: row.fx_quote_id,
    fxRateLocked:
      row.fx_rate_locked === null ? null : Number(row.fx_rate_locked),
  };
}

function createTransactionService({ dbPool }) {
  const ledgerService = createLedgerService({ dbPool });

  async function createTransfer(payload, headers = {}) {
    if (!payload || typeof payload !== "object") {
      throw createError("INVALID_INPUT");
    }

    const keyFromHeader =
      headers["idempotency-key"] || headers["Idempotency-Key"] || null;

    const keyFromBody = payload.idempotencyKey;

    if (keyFromHeader && keyFromBody && keyFromHeader !== keyFromBody) {
      throw createError("IDEMPOTENCY_KEY_MISMATCH", 409);
    }

    const idempotencyKey = keyFromHeader || keyFromBody;

    if (!idempotencyKey) {
      throw createError("MISSING_IDEMPOTENCY_KEY");
    }

    if (payload.fxQuoteId && !isUUID(payload.fxQuoteId)) {
      throw createError("INVALID_QUOTE_ID");
    }

    const transferPayload = {
      senderWalletId: payload.senderWalletId,
      receiverWalletId: payload.receiverWalletId,
      amountMinor: payload.amountMinor,
      currency: payload.currency,
      idempotencyKey,
      fxQuoteId: payload.fxQuoteId || null,
    };

    return ledgerService.createTransfer(transferPayload);
  }

  async function getTransferById(transferId) {
    if (!transferId || !isUUID(transferId)) {
      throw createError("INVALID_TRANSFER_ID");
    }

    const result = await dbPool.query(
      `SELECT * FROM transfers WHERE transfer_id = $1`,
      [transferId],
    );

    if (result.rowCount === 0) {
      throw createError("TRANSFER_NOT_FOUND", 404);
    }

    const ledgerRows = await dbPool.query(
      `SELECT * FROM ledger_entries
       WHERE transfer_id = $1
       ORDER BY created_at ASC`,
      [transferId],
    );

    const transfer = toPublicTransfer(result.rows[0]);

    transfer.ledgerEntries = ledgerRows.rows.map((row) => ({
      entryId: row.entry_id,
      walletId: row.wallet_id,
      direction: row.direction,
      amountMinor: toInt(row.amount_minor),
      currency: row.currency,
      createdAt: row.created_at,
    }));

    return transfer;
  }

  async function listTransfersByWallet(walletId, limit = 50) {
    if (!walletId || !isUUID(walletId)) {
      throw createError("INVALID_WALLET_ID");
    }

    const normalizedLimit = parseInt(limit, 10);

    if (
      !Number.isInteger(normalizedLimit) ||
      normalizedLimit < 1 ||
      normalizedLimit > 100
    ) {
      throw createError("INVALID_LIMIT");
    }

    const result = await dbPool.query(
      `SELECT * FROM transfers
       WHERE sender_wallet_id = $1 OR receiver_wallet_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [walletId, normalizedLimit],
    );

    return result.rows.map(toPublicTransfer);
  }

  return {
    createTransfer,
    getTransferById,
    listTransfersByWallet,
  };
}

module.exports = { createTransactionService };
