const { NodeSDK } = require("@opentelemetry/sdk-node");
const {
  getNodeAutoInstrumentations,
} = require("@opentelemetry/auto-instrumentations-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");

async function initTracing() {
  const traceExporter = new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      "http://jaeger:4318/v1/traces",
  });

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || "novapay-api",
    traceExporter,
    instrumentations: [getNodeAutoInstrumentations()],
  });

  await sdk.start();
  return sdk;
}

module.exports = {
  initTracing,
};
