import { humanFallbackLine } from "./beta1-presence.js";

export class V3Error extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "V3Error";
  }
}

/**
 * B11/B12: two layers. The USER gets a short human GUTO line (never a raw
 * technical message); LOGS keep code + stack + details. The requestId-stable
 * pick avoids wording flip-flops between retries of the same request.
 */
export function userFacingV3Message(error: unknown, requestId: string): string {
  if (error instanceof V3Error) return error.message;
  return humanFallbackLine(requestId);
}

export function asV3Error(error: unknown): V3Error {
  if (error instanceof V3Error) return error;
  return new V3Error("V3_INTERNAL_ERROR", "Falha interna do Cérebro V3.", 500, {
    cause: error instanceof Error ? error.name : "unknown",
  });
}

/** Zod errors can cross package/realm boundaries in the bundled runtime. */
export function isZodLikeError(error: unknown): error is { issues: Array<{ path: PropertyKey[]; code: string }> } {
  return error instanceof Error && error.name === "ZodError" && Array.isArray((error as { issues?: unknown }).issues);
}

/** Technical diagnostics stay in logs; only intentional domain details are public. */
export function publicV3ErrorDetails(source: unknown, parsed: V3Error): Record<string, unknown> | undefined {
  return source instanceof V3Error && parsed.status < 500 ? parsed.details : undefined;
}
