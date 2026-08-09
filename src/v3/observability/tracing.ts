import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { SpanStatusCode, context, trace, type Attributes } from "@opentelemetry/api";

interface V3TraceContext {
  traceId: string;
  requestId: string;
  userHash: string;
}

const storage = new AsyncLocalStorage<V3TraceContext>();
const tracer = trace.getTracer("guto-v3", "3.0.0");

export function hashTraceUser(externalSubject: string): string {
  const salt = process.env.GUTO_V3_TRACE_HASH_SALT || process.env.JWT_SECRET || "guto-v3-local";
  return createHash("sha256").update(salt).update(":").update(externalSubject).digest("hex").slice(0, 24);
}

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function currentTraceId(): string {
  return storage.getStore()?.traceId || trace.getSpan(context.active())?.spanContext().traceId || newTraceId();
}

export async function withV3Trace<T>(input: {
  requestId: string;
  externalSubject: string;
  attributes?: Attributes;
}, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan("GUTO_TURN", {
    attributes: {
      "guto.request_id": input.requestId,
      "guto.user_hash": hashTraceUser(input.externalSubject),
      "guto.brain_version": "guto-cerebro-v3",
      "guto.app_version": process.env.VERCEL_GIT_COMMIT_SHA || "local",
      "guto.prompt_version": "v3.1",
      ...input.attributes,
    },
  }, async (span) => {
    const spanTraceId = span.spanContext().traceId;
    const traceId = spanTraceId && !/^0+$/.test(spanTraceId) ? spanTraceId : newTraceId();
    try {
      const result = await storage.run({
        traceId,
        requestId: input.requestId,
        userHash: hashTraceUser(input.externalSubject),
      }, fn);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error("Unknown V3 trace failure"));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.name : "unknown" });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function withV3Span<T>(name: string, attributes: Attributes, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(`Unknown ${name} failure`));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.name : "unknown" });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function traceMetadata(): V3TraceContext | null {
  return storage.getStore() || null;
}

export function setActiveSpanAttributes(attributes: Attributes): void {
  trace.getSpan(context.active())?.setAttributes(attributes);
}
