const client = require("prom-client");

const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: "novapay_" });

const httpDuration = new client.Histogram({
  name: "novapay_http_request_duration_seconds",
  help: "HTTP request latency in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

const transactionThroughput = new client.Counter({
  name: "novapay_transaction_requests_total",
  help: "Transaction throughput and outcomes",
  labelNames: ["outcome", "flow"],
});

const ledgerInvariantViolationCount = new client.Counter({
  name: "novapay_ledger_invariant_violations_total",
  help: "Ledger invariant violation count",
});

register.registerMetric(httpDuration);
register.registerMetric(transactionThroughput);
register.registerMetric(ledgerInvariantViolationCount);

function routeLabel(req) {
  if (req.baseUrl && req.route && req.route.path) {
    return `${req.baseUrl}${req.route.path}`;
  }
  if (req.route && req.route.path) {
    return req.route.path;
  }
  return req.path || "unknown";
}

function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();

  res.on("finish", () => {
    const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const route = routeLabel(req);
    const statusCode = String(res.statusCode);

    httpDuration.labels(req.method, route, statusCode).observe(elapsedSeconds);

    if (route === "/transactions/transfers" && req.method === "POST") {
      const outcome = res.statusCode < 400 ? "success" : "failed";
      transactionThroughput.labels(outcome, "transaction").inc();
    }

    if (route === "/ledger/transfers" && req.method === "POST") {
      const outcome = res.statusCode < 400 ? "success" : "failed";
      transactionThroughput.labels(outcome, "ledger").inc();
    }
  });

  next();
}

async function metricsHandler(req, res) {
  res.setHeader("Content-Type", register.contentType);
  res.end(await register.metrics());
}

function incrementLedgerInvariantViolation() {
  ledgerInvariantViolationCount.inc();
}

module.exports = {
  metricsMiddleware,
  metricsHandler,
  incrementLedgerInvariantViolation,
};
