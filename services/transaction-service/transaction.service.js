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

    const client = await dbPool.connect();

    try {
      await client.query("BEGIN");

      let fxQuote = null;

      if (payload.fxQuoteId) {
        if (!isUUID(payload.fxQuoteId)) {
          throw createError("INVALID_QUOTE_ID");
        }

        const quoteRes = await client.query(
          `SELECT * FROM fx_quotes
           WHERE quote_id = $1
           FOR UPDATE`,
          [payload.fxQuoteId],
        );

        if (quoteRes.rowCount === 0) {
          throw createError("QUOTE_NOT_FOUND", 404);
        }

        const quote = quoteRes.rows[0];

        if (quote.status !== "ACTIVE") {
          throw createError("QUOTE_ALREADY_USED_OR_EXPIRED", 409);
        }

        if (new Date(quote.expires_at) <= new Date()) {
          await client.query(
            `UPDATE fx_quotes SET status='EXPIRED' WHERE quote_id=$1`,
            [payload.fxQuoteId],
          );
          throw createError("QUOTE_EXPIRED", 409);
        }

        await client.query(
          `UPDATE fx_quotes
           SET status='USED', used_at=NOW()
           WHERE quote_id=$1`,
          [payload.fxQuoteId],
        );

        fxQuote = quote;
      }

      const transferPayload = {
        senderWalletId: payload.senderWalletId,
        receiverWalletId: payload.receiverWalletId,
        amountMinor: payload.amountMinor,
        currency: fxQuote ? fxQuote.source_currency : payload.currency,
        idempotencyKey,
        fxQuoteId: fxQuote ? fxQuote.quote_id : null,
        fxRateLocked: fxQuote ? fxQuote.rate : null,
      };

      const result = await ledgerService.createTransfer(
        transferPayload,
        client,
      );

      await client.query("COMMIT");

      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
