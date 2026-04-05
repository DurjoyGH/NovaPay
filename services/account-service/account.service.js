function normalizeCurrency(currency) {
  if (!currency || typeof currency !== "string") return null;
  const normalized = currency.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;
  return normalized;
}

function isUUID(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function createError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function toPublicWallet(row) {
  return {
    walletId: row.wallet_id,
    userId: row.user_id,
    currency: row.currency,
    balanceMinor: parseInt(row.balance_minor, 10),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createAccountService({ dbPool }) {
  async function createWallet(payload) {
    if (!payload || typeof payload !== "object") {
      throw createError("INVALID_INPUT");
    }

    const userId = payload.userId;
    const currency = normalizeCurrency(payload.currency);
    const initialBalanceMinor =
      payload.initialBalanceMinor === undefined
        ? 0
        : Number(payload.initialBalanceMinor);

    if (!userId || !isUUID(userId)) {
      throw createError("INVALID_USER_ID");
    }

    if (!currency) {
      throw createError("INVALID_CURRENCY");
    }

    if (!Number.isInteger(initialBalanceMinor) || initialBalanceMinor < 0) {
      throw createError("INVALID_INITIAL_BALANCE");
    }

    try {
      const result = await dbPool.query(
        `INSERT INTO wallets (user_id, currency, balance_minor)
         VALUES ($1, $2, $3)
         RETURNING wallet_id, user_id, currency, balance_minor, created_at, updated_at`,
        [userId, currency, initialBalanceMinor],
      );

      return toPublicWallet(result.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        throw createError("WALLET_ALREADY_EXISTS_FOR_USER_CURRENCY", 409);
      }
      throw error;
    }
  }

  async function getWalletById(walletId) {
    if (!walletId || !isUUID(walletId)) {
      throw createError("INVALID_WALLET_ID");
    }

    const result = await dbPool.query(
      `SELECT wallet_id, user_id, currency, balance_minor, created_at, updated_at
       FROM wallets
       WHERE wallet_id = $1`,
      [walletId],
    );

    if (result.rowCount === 0) {
      throw createError("WALLET_NOT_FOUND", 404);
    }

    return toPublicWallet(result.rows[0]);
  }

  async function listUserWallets(userId) {
    if (!userId || !isUUID(userId)) {
      throw createError("INVALID_USER_ID");
    }

    const result = await dbPool.query(
      `SELECT wallet_id, user_id, currency, balance_minor, created_at, updated_at
       FROM wallets
       WHERE user_id = $1
       ORDER BY currency
       LIMIT 100`,
      [userId],
    );

    return result.rows.map(toPublicWallet);
  }

  return {
    createWallet,
    getWalletById,
    listUserWallets,
  };
}

module.exports = { createAccountService };
