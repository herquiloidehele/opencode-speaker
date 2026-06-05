const QUOTA_PATTERNS = [
  /exceeded your current quota/i,
  /insufficient_quota/i,
  /quota exceeded/i,
]

function errorText(err: unknown, seen = new Set<unknown>()): string {
  if (err == null || seen.has(err)) return ""
  seen.add(err)

  if (err instanceof Error) {
    return [err.name, err.message, errorText(err.cause, seen)].join(" ")
  }

  if (typeof err === "object") {
    const record = err as Record<string, unknown>
    return [
      typeof record.name === "string" ? record.name : "",
      typeof record.message === "string" ? record.message : "",
      errorText(record.cause, seen),
    ].join(" ")
  }

  return String(err)
}

export function isQuotaError(err: unknown): boolean {
  const text = errorText(err)
  return QUOTA_PATTERNS.some((pattern) => pattern.test(text))
}
