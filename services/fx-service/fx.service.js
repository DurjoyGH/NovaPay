const TTL_SECONDS = 60;

function isUUID(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}

function createError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function normalizeCurrency(value) {
  if (!value || typeof value !== "string") return null;
  const normalized = value.toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) return null;
  return normalized;
}

function toPublicQuote(row) {
  const now = Date.now();
  const expiresAt = new Date(row.expires_at).getTime();
  const remainingMs = Math.max(0, expiresAt - now);

  return {
    quoteId: row.quote_id,
    sourceCurrency: row.source_currency,
    targetCurrency: row.target_currency,
    rate: Number(row.rate),
    ttlSeconds: Number(row.ttl_seconds),
    status: row.status,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    secondsRemaining: Math.floor(remainingMs / 1000),
    valid: row.status === "ACTIVE" && remainingMs > 0,
  };
}

function fetchRateOrThrow(sourceCurrency, targetCurrency) {
  if ((process.env.FX_PROVIDER_UP || "true").toLowerCase() !== "true") {
    throw createError("FX_PROVIDER_UNAVAILABLE", 503);
  }

  if (sourceCurrency === targetCurrency) return 1;

  const table = {
    USD_BDT: 120,
    BDT_USD: 0.0083333333,
    USD_EUR: 0.92,
    EUR_USD: 1.0869565217,
    USD_GBP: 0.78,
    GBP_USD: 1.2820512821,
  };

  const key = `${sourceCurrency}_${targetCurrency}`;
  const rate = table[key];

  if (!rate) throw createError("FX_PAIR_NOT_SUPPORTED", 400);

  return Number(rate.toFixed(10));
}

function createFxService({ dbPool }) {
  async function issueQuote(payload) {
    if (!payload || typeof payload !== "object") {
      throw createError("INVALID_INPUT");
    }

    const sourceCurrency = normalizeCurrency(payload.sourceCurrency);
    const targetCurrency = normalizeCurrency(payload.targetCurrency);

    if (!sourceCurrency || !targetCurrency) {
      throw createError("INVALID_CURRENCY");
    }

    const rate = fetchRateOrThrow(sourceCurrency, targetCurrency);

    const result = await dbPool.query(
      `INSERT INTO fx_quotes (source_currency, target_currency, rate, ttl_seconds, status, expires_at)
       VALUES ($1, $2, $3, $4, 'ACTIVE', NOW() + INTERVAL '60 seconds')
       RETURNING *`,
      [sourceCurrency, targetCurrency, rate, TTL_SECONDS],
    );

    return toPublicQuote(result.rows[0]);
  }

  async function getQuote(quoteId) {
    if (!quoteId || !isUUID(quoteId)) {
      throw createError("INVALID_QUOTE_ID");
    }

    const result = await dbPool.query(
      `SELECT * FROM fx_quotes WHERE quote_id = $1`,
      [quoteId],
    );

    if (result.rowCount === 0) {
      throw createError("QUOTE_NOT_FOUND", 404);
    }

    const quote = result.rows[0];
    const now = new Date();

    if (quote.status === "ACTIVE" && new Date(quote.expires_at) <= now) {
      const expired = await dbPool.query(
        `UPDATE fx_quotes SET status = 'EXPIRED'
         WHERE quote_id = $1 RETURNING *`,
        [quoteId],
      );
      return toPublicQuote(expired.rows[0]);
    }

    return toPublicQuote(quote);
  }

  return {
    issueQuote,
    getQuote,
  };
}

module.exports = { createFxService };