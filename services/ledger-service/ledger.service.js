const { randomUUID, createHash } = require("crypto");

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
    idempotentReplay,
  };
}

function isSameTransferPayload(existing, payload) {
  return (
    existing.sender_wallet_id === payload.senderWalletId &&
    existing.receiver_wallet_id === payload.receiverWalletId &&
    Number(existing.amount_minor) === Number(payload.amountMinor) &&
    existing.currency === payload.currency.toUpperCase()
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

      try {
        await client.query(
          `INSERT INTO idempotency_keys (idempotency_key, request_hash, status, expires_at)
           VALUES ($1, $2, 'IN_PROGRESS', NOW() + INTERVAL '24 hours')`,
          [payload.idempotencyKey, requestHash],
        );
      } catch (e) {
        if (e.code !== "23505") throw e;
      }

      const existingTransfer = await client.query(
        `SELECT * FROM transfers WHERE idempotency_key = $1`,
        [payload.idempotencyKey],
      );

      if (existingTransfer.rowCount === 1) {
        const existing = existingTransfer.rows[0];

        if (!isSameTransferPayload(existing, payload)) {
          const err = new Error("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
          err.statusCode = 409;
          throw err;
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

      if (!sender || !receiver) {
        throw Object.assign(new Error("WALLET_NOT_FOUND"), { statusCode: 404 });
      }

      if (sender.currency !== currency || receiver.currency !== currency) {
        throw Object.assign(new Error("CURRENCY_MISMATCH"), {
          statusCode: 409,
        });
      }

      if (BigInt(sender.balance_minor) < BigInt(payload.amountMinor)) {
        throw Object.assign(new Error("INSUFFICIENT_FUNDS"), {
          statusCode: 409,
        });
      }

      const transferRes = await client.query(
        `INSERT INTO transfers (idempotency_key, sender_wallet_id, receiver_wallet_id, amount_minor, currency, status)
         VALUES ($1, $2, $3, $4, $5, 'PENDING')
         RETURNING *`,
        [
          payload.idempotencyKey,
          payload.senderWalletId,
          payload.receiverWalletId,
          payload.amountMinor,
          currency,
        ],
      );

      const transfer = transferRes.rows[0];

      await client.query(
        `INSERT INTO ledger_entries (entry_id, transfer_id, wallet_id, direction, amount_minor, currency)
         VALUES
         ($1, $3, $4, 'DEBIT', $5, $6),
         ($2, $3, $7, 'CREDIT', $5, $6)`,
        [
          randomUUID(),
          randomUUID(),
          transfer.transfer_id,
          payload.senderWalletId,
          payload.amountMinor,
          currency,
          payload.receiverWalletId,
        ],
      );

      await client.query(
        `UPDATE wallets
         SET balance_minor = CASE
           WHEN wallet_id = $1 THEN balance_minor - $3
           WHEN wallet_id = $2 THEN balance_minor + $3
         END,
         updated_at = NOW()
         WHERE wallet_id IN ($1, $2)`,
        [payload.senderWalletId, payload.receiverWalletId, payload.amountMinor],
      );

      const check = await client.query(
        `SELECT
           SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE 0 END) AS debit,
           SUM(CASE WHEN direction='CREDIT' THEN amount_minor ELSE 0 END) AS credit
         FROM ledger_entries
         WHERE transfer_id = $1`,
        [transfer.transfer_id],
      );

      if (check.rows[0].debit !== check.rows[0].credit) {
        throw new Error("LEDGER_INVARIANT_VIOLATION");
      }

      const final = await client.query(
        `UPDATE transfers SET status='COMPLETED'
         WHERE transfer_id=$1 RETURNING *`,
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

      if (error.code === "23505") {
        const retry = await dbPool.query(
          `SELECT * FROM transfers WHERE idempotency_key = $1`,
          [payload.idempotencyKey],
        );

        if (retry.rowCount === 1) {
          return toPublicTransfer(retry.rows[0], true);
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }

  return { createTransfer };
}

module.exports = { createLedgerService };
