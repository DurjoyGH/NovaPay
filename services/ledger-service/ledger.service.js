const { randomUUID, createHash } = require("crypto");
const {
  incrementLedgerInvariantViolation,
} = require("../../shared/observability/metrics");

function hashPayload(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function toPublicTransfer(row, idempotentReplay) {
  return {
    transferId: row.transfer_id,
    idempotencyKey: row.idempotency_key,
    senderWalletId: row.sender_wallet_id,
    receiverWalletId: row.receiver_wallet_id,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    fxQuoteId: row.fx_quote_id,
    fxRateLocked:
      row.fx_rate_locked === null ? null : Number(row.fx_rate_locked),
    idempotentReplay,
  };
}

function isSameTransferPayload(existing, payload) {
  return (
    existing.sender_wallet_id === payload.senderWalletId &&
    existing.receiver_wallet_id === payload.receiverWalletId &&
    Number(existing.amount_minor) === Number(payload.amountMinor) &&
    existing.currency === payload.currency.toUpperCase() &&
    (existing.fx_quote_id || null) === (payload.fxQuoteId || null)
  );
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return "INVALID_INPUT";
  if (!payload.idempotencyKey) return "MISSING_IDEMPOTENCY_KEY";
  if (!payload.senderWalletId || !payload.receiverWalletId)
    return "MISSING_WALLET_ID";
  if (payload.senderWalletId === payload.receiverWalletId) return "SAME_WALLET";

  const amount = Number(payload.amountMinor);
  if (!Number.isInteger(amount) || amount <= 0) return "INVALID_AMOUNT";

  if (!payload.currency || !/^[A-Z]{3}$/.test(payload.currency.toUpperCase())) {
    return "INVALID_CURRENCY";
  }

  if (payload.fxQuoteId && !/^[0-9a-f-]{36}$/i.test(payload.fxQuoteId)) {
    return "INVALID_QUOTE_ID";
  }

  return null;
}

function createLedgerService({ dbPool }) {
  async function createTransfer(payload) {
    const validationError = validatePayload(payload);
    if (validationError) {
      const err = new Error(validationError);
      err.statusCode = 400;
      throw err;
    }

    const client = await dbPool.connect();
    const requestHash = hashPayload(payload);
    const currency = payload.currency.toUpperCase();

    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO idempotency_keys (idempotency_key, request_hash, status, expires_at)
         VALUES ($1, $2, 'IN_PROGRESS', NOW() + INTERVAL '24 hours')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [payload.idempotencyKey, requestHash],
      );

      const idempotencyRow = await client.query(
        `SELECT idempotency_key, request_hash, expires_at
         FROM idempotency_keys
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [payload.idempotencyKey],
      );

      if (idempotencyRow.rowCount === 1) {
        const idem = idempotencyRow.rows[0];

        if (idem.request_hash !== requestHash) {
          throw Object.assign(new Error("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH"), {
            statusCode: 409,
          });
        }

        if (new Date(idem.expires_at) <= new Date()) {
          throw Object.assign(new Error("IDEMPOTENCY_KEY_EXPIRED"), {
            statusCode: 409,
          });
        }
      }

      const existingTransfer = await client.query(
        `SELECT * FROM transfers WHERE idempotency_key = $1`,
        [payload.idempotencyKey],
      );

      if (existingTransfer.rowCount === 1) {
        const existing = existingTransfer.rows[0];

        if (!isSameTransferPayload(existing, payload)) {
          throw Object.assign(new Error("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH"), {
            statusCode: 409,
          });
        }

        await client.query("COMMIT");
        return toPublicTransfer(existing, true);
      }

      const wallets = await client.query(
        `SELECT wallet_id, currency, balance_minor
         FROM wallets
         WHERE wallet_id = ANY($1::uuid[])
         ORDER BY wallet_id
         FOR UPDATE`,
        [[payload.senderWalletId, payload.receiverWalletId]],
      );

      if (wallets.rowCount !== 2) {
        throw Object.assign(new Error("WALLET_NOT_FOUND"), { statusCode: 404 });
      }

      const sender = wallets.rows.find(
        (w) => w.wallet_id === payload.senderWalletId,
      );
      const receiver = wallets.rows.find(
        (w) => w.wallet_id === payload.receiverWalletId,
      );

      let fxQuoteId = null;
      let fxRateLocked = null;
      let debitAmount = payload.amountMinor;
      let creditAmount = payload.amountMinor;
      let creditCurrency = currency;

      if (payload.fxQuoteId) {
        const quoteRes = await client.query(
          `SELECT * FROM fx_quotes WHERE quote_id = $1 FOR UPDATE`,
          [payload.fxQuoteId],
        );

        if (quoteRes.rowCount === 0) {
          throw Object.assign(new Error("QUOTE_NOT_FOUND"), {
            statusCode: 404,
          });
        }

        const quote = quoteRes.rows[0];

        if (quote.status !== "ACTIVE") {
          throw Object.assign(new Error("QUOTE_ALREADY_USED_OR_EXPIRED"), {
            statusCode: 409,
          });
        }

        if (new Date(quote.expires_at) <= new Date()) {
          await client.query(
            `UPDATE fx_quotes SET status='EXPIRED' WHERE quote_id=$1`,
            [payload.fxQuoteId],
          );
          throw Object.assign(new Error("QUOTE_EXPIRED"), { statusCode: 409 });
        }

        if (sender.currency !== quote.source_currency) {
          throw Object.assign(new Error("FX_SOURCE_CURRENCY_MISMATCH"), {
            statusCode: 409,
          });
        }

        if (receiver.currency !== quote.target_currency) {
          throw Object.assign(new Error("FX_TARGET_CURRENCY_MISMATCH"), {
            statusCode: 409,
          });
        }

        fxQuoteId = quote.quote_id;
        fxRateLocked = Number(quote.rate);

        debitAmount = payload.amountMinor;
        creditAmount = Math.floor(payload.amountMinor * fxRateLocked);
        creditCurrency = quote.target_currency;

        await client.query(
          `UPDATE fx_quotes SET status='USED', used_at=NOW() WHERE quote_id=$1`,
          [fxQuoteId],
        );
      } else {
        if (sender.currency !== currency || receiver.currency !== currency) {
          throw Object.assign(new Error("CURRENCY_MISMATCH"), {
            statusCode: 409,
          });
        }
      }

      if (BigInt(sender.balance_minor) < BigInt(debitAmount)) {
        throw Object.assign(new Error("INSUFFICIENT_FUNDS"), {
          statusCode: 409,
        });
      }

      const transferRes = await client.query(
        `INSERT INTO transfers
         (idempotency_key, sender_wallet_id, receiver_wallet_id, amount_minor, currency, status, fx_quote_id, fx_rate_locked)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)
         RETURNING *`,
        [
          payload.idempotencyKey,
          payload.senderWalletId,
          payload.receiverWalletId,
          debitAmount,
          sender.currency,
          fxQuoteId,
          fxRateLocked,
        ],
      );

      const transfer = transferRes.rows[0];

      await client.query(
        `INSERT INTO ledger_entries
         (entry_id, transfer_id, wallet_id, direction, amount_minor, currency, fx_quote_id, fx_rate_locked)
         VALUES
         ($1, $3, $4, 'DEBIT', $5, $6, $9, $10),
         ($2, $3, $7, 'CREDIT', $8, $11, $9, $10)`,
        [
          randomUUID(),
          randomUUID(),
          transfer.transfer_id,
          payload.senderWalletId,
          debitAmount,
          sender.currency,
          payload.receiverWalletId,
          creditAmount,
          fxQuoteId,
          fxRateLocked,
          creditCurrency,
        ],
      );

      await client.query(
        `UPDATE wallets
         SET balance_minor = CASE
           WHEN wallet_id = $1 THEN balance_minor - $3
           WHEN wallet_id = $2 THEN balance_minor + $4
         END,
         updated_at = NOW()
         WHERE wallet_id IN ($1, $2)`,
        [
          payload.senderWalletId,
          payload.receiverWalletId,
          debitAmount,
          creditAmount,
        ],
      );

      const check = await client.query(
        `SELECT
           COUNT(*) AS entry_count,
           SUM(CASE WHEN direction='DEBIT' THEN 1 ELSE 0 END) AS debit_count,
           SUM(CASE WHEN direction='CREDIT' THEN 1 ELSE 0 END) AS credit_count,
           SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE 0 END) AS debit_amount,
           SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE 0 END) AS credit_amount,
           MIN(CASE WHEN direction='DEBIT' THEN currency ELSE NULL END) AS debit_currency,
           MIN(CASE WHEN direction='CREDIT' THEN currency ELSE NULL END) AS credit_currency
         FROM ledger_entries
         WHERE transfer_id = $1`,
        [transfer.transfer_id],
      );

      const invariant = check.rows[0];
      const isMalformedEntries =
        Number(invariant.entry_count) !== 2 ||
        Number(invariant.debit_count) !== 1 ||
        Number(invariant.credit_count) !== 1;

      const isSameCurrencyTransfer = !fxQuoteId;
      const isSameCurrencyAmountMismatch =
        isSameCurrencyTransfer &&
        (invariant.debit_amount !== invariant.credit_amount ||
          invariant.debit_currency !== invariant.credit_currency);

      if (isMalformedEntries || isSameCurrencyAmountMismatch) {
        incrementLedgerInvariantViolation();
        throw new Error("LEDGER_INVARIANT_VIOLATION");
      }

      const final = await client.query(
        `UPDATE transfers SET status='COMPLETED' WHERE transfer_id=$1 RETURNING *`,
        [transfer.transfer_id],
      );

      await client.query(
        `UPDATE idempotency_keys
         SET status='COMPLETED', response_body=$2
         WHERE idempotency_key=$1`,
        [payload.idempotencyKey, final.rows[0]],
      );

      await client.query("COMMIT");

      return toPublicTransfer(final.rows[0], false);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  return { createTransfer };
}

module.exports = { createLedgerService };
