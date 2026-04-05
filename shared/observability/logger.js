function sanitizeMeta(meta) {
  const sanitized = { ...meta };
  const blockedKeys = [
    "password",
    "token",
    "card",
    "cardNumber",
    "cvv",
    "authorization",
  ];

  for (const key of Object.keys(sanitized)) {
    const lower = key.toLowerCase();
    if (blockedKeys.some((blocked) => lower.includes(blocked.toLowerCase()))) {
      sanitized[key] = "[REDACTED]";
    }
  }

  return sanitized;
}

function write(level, { message, requestId, userId, transactionId, ...meta }) {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    message,
    requestId: requestId || null,
    userId: userId || null,
    transactionId: transactionId || null,
    ...sanitizeMeta(meta),
  };

  const output = `${JSON.stringify(line)}\n`;
  if (level === "error") {
    process.stderr.write(output);
    return;
  }
  process.stdout.write(output);
}

function logInfo(fields) {
  write("info", fields);
}

function logError(fields) {
  write("error", fields);
}

module.exports = {
  logInfo,
  logError,
};
