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

// OpenCode renamed/restructured a few events between SDK generations. We pin
// the rest of the plugin to a small set of canonical names and let normalize
// translate whatever the runtime currently emits into that vocabulary.
const TYPE_ALIASES: Record<string, string> = {
  "permission.updated": "permission.asked",          // v1 SDK name
  "session.next.tool.called": "tool.execute.before", // v2 SDK
  "session.next.tool.success": "tool.execute.after", // v2 SDK
  "session.next.tool.failed": "tool.execute.after",  // v2 SDK
}

export function normalizeEvent(raw: RawEvent): CanonicalEvent {
  const props = objectRecord(raw.properties)
  // v1 `permission.updated` payload is a Permission, whose own `type` field
  // (the action, e.g. "bash") collides with the event type when spread. Pull
  // it out before the merge so we don't lose it.
  const propType = typeof props.type === "string" ? props.type : undefined

  const canonicalType = TYPE_ALIASES[raw.type] ?? raw.type
  const merged: CanonicalEvent = { ...raw, ...props, type: canonicalType }

  if (canonicalType === "permission.asked" || canonicalType === "permission.replied") {
    const meta = objectRecord(merged.metadata)
    // v2 PermissionRequest.tool is `{ messageID, callID }` — useless as a
    // spoken name. The friendly action is in `permission` (v2), `metadata.tool`
    // (older shape), `title` (v1 Permission), or `type` (v1 Permission, which
    // we rescued into `propType` above).
    const toolName = firstString(
      typeof merged.tool === "string" ? merged.tool : undefined,
      merged.permission, // v2 PermissionRequest.permission
      propType,          // v1 Permission.type (rescued from properties)
      meta.tool,         // older shape: permission metadata
      merged.title,      // last-resort v1 fallback (often long-form like "Run a shell command")
    )
    const next: CanonicalEvent = { ...merged, tool: toolName }
    if (canonicalType === "permission.replied") {
      next.decision =
        firstString(merged.decision, merged.response, merged.reply, merged.result) ?? "responded"
    }
    return next
  }

  if (canonicalType === "tool.execute.before" || canonicalType === "tool.execute.after") {
    return {
      ...merged,
      tool: firstString(merged.tool, merged.name),
      callID: firstString(merged.callID, merged.callId, merged.id),
    }
  }

  if (canonicalType === "session.error") {
    const err = objectRecord(merged.error)
    const errData = objectRecord(err.data)
    return {
      ...merged,
      // Real shape: properties.error.data.message. Fall back to a top-level
      // `message` only because old/synthesized events sometimes use it.
      message: firstString(merged.message, errData.message, err.message),
      errorName: firstString(err.name, errData.name),
    }
  }

  if (canonicalType === "file.edited") {
    return {
      ...merged,
      file: firstString(merged.file, merged.path, merged.filePath),
    }
  }

  if (canonicalType === "command.executed" || canonicalType === "tui.command.execute") {
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
