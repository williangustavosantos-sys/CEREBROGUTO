export function isValidUserId(userId: unknown): userId is string {
  return typeof userId === "string" && userId.trim().length > 0;
}

export function assertValidUserId(userId: unknown): asserts userId is string {
  if (!isValidUserId(userId)) {
    throw new TypeError("A non-empty GUTO userId is required.");
  }
}
