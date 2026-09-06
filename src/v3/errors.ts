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
