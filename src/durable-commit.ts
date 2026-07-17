export async function verifyDurableCommit<TSnapshot, TValue>(options: {
  readPersisted: () => Promise<TSnapshot | null>
  selectValue: (snapshot: TSnapshot) => TValue | null | undefined
  retryCommit: () => Promise<void>
  maxRetries?: number
}): Promise<{ snapshot: TSnapshot; value: TValue; retries: number } | null> {
  const maxRetries = Math.max(0, options.maxRetries ?? 2)

  for (let retries = 0; retries <= maxRetries; retries += 1) {
    const snapshot = await options.readPersisted()
    if (snapshot) {
      const value = options.selectValue(snapshot)
      if (value) return { snapshot, value, retries }
    }
    if (retries < maxRetries) await options.retryCommit()
  }

  return null
}
