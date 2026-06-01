export interface RawEvent {
  type: string
  properties?: unknown
  [key: string]: unknown
}

export type CanonicalEvent = { type: string; [key: string]: unknown }

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value
  }
  return undefined
}

export function normalizeEvent(raw: RawEvent): CanonicalEvent {
  const props = objectRecord(raw.properties)
  const merged: CanonicalEvent = { ...raw, ...props, type: raw.type }

  if (raw.type === "permission.replied") {
    return {
      ...merged,
      decision: firstString(merged.decision, merged.response, merged.reply, merged.result) ?? "responded",
    }
  }

  if (raw.type === "file.edited") {
    return {
      ...merged,
      file: firstString(merged.file, merged.path, merged.filePath),
    }
  }

  if (raw.type === "command.executed" || raw.type === "tui.command.execute") {
    return {
      ...merged,
      command: firstString(merged.command, merged.name, merged.id),
    }
  }

  return merged
}

export function commandNameFromEvent(raw: RawEvent): string | null {
  const event = normalizeEvent(raw)
  return typeof event.command === "string"
    ? event.command.replace(/^\/+/, "").toLowerCase()
    : null
}
