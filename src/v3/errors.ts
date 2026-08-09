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

export function asV3Error(error: unknown): V3Error {
  if (error instanceof V3Error) return error;
  return new V3Error("V3_INTERNAL_ERROR", "Falha interna do Cérebro V3.", 500, {
    cause: error instanceof Error ? error.name : "unknown",
  });
}
