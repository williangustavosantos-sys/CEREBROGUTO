import "dotenv/config";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";

const globalTelemetry = globalThis as typeof globalThis & {
  __gutoV3TelemetrySdk?: NodeSDK;
  __gutoV3TelemetryStarted?: boolean;
};

const hasLangfuse = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

if (hasLangfuse && !globalTelemetry.__gutoV3TelemetryStarted) {
  const processor = new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_BASE_URL,
    environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    shouldExportSpan: ({ otelSpan }) =>
      isDefaultExportSpan(otelSpan) || otelSpan.instrumentationScope.name.startsWith("guto-v3"),
  });
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  globalTelemetry.__gutoV3TelemetrySdk = sdk;
  globalTelemetry.__gutoV3TelemetryStarted = true;
}

export async function shutdownV3Telemetry(): Promise<void> {
  await globalTelemetry.__gutoV3TelemetrySdk?.shutdown();
  globalTelemetry.__gutoV3TelemetrySdk = undefined;
  globalTelemetry.__gutoV3TelemetryStarted = false;
}

export function isLangfuseConfigured(): boolean {
  return hasLangfuse;
}

