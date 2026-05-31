const SENSITIVE_KEYS = new Set([
  "apiKey", "api_key", "apikey",
  "authorization", "Authorization",
  "secret", "token", "password",
])

export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet())
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== "object") return value
  if (seen.has(value as object)) return "[Circular]"
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((v) => redactInner(v, seen))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEYS.has(k) ? "***" : redactInner(v, seen)
  }
  return out
}

const MAX_FIELD_BYTES = 4096

export function truncatePayload(value: unknown): unknown {
  return truncateInner(value, new WeakSet(), false)
}

function truncateInner(
  value: unknown,
  seen: WeakSet<object>,
  insideErrorStack: boolean,
): unknown {
  if (typeof value === "string") {
    if (insideErrorStack) return value
    const bytes = Buffer.byteLength(value, "utf8")
    if (bytes <= MAX_FIELD_BYTES) return value
    const head = Buffer.from(value, "utf8").subarray(0, MAX_FIELD_BYTES).toString("utf8")
    return `${head}…<truncated:${bytes - MAX_FIELD_BYTES} bytes>`
  }
  if (value === null || typeof value !== "object") return value
  if (seen.has(value as object)) return value
  seen.add(value as object)
  if (Array.isArray(value)) return value.map((v) => truncateInner(v, seen, insideErrorStack))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    const exempt = k === "stack"
    out[k] = truncateInner(v, seen, exempt)
  }
  return out
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface SerializedError {
  name: string
  message: string
  code?: string | number
  stack?: string
  file?: string
  line?: number
  column?: number
  function?: string
  cause?: SerializedError
}

export interface LogContext {
  error?: unknown
  operation?: string
  input?: unknown
  [key: string]: unknown
}

export interface Logger {
  debug(msg: string, ctx?: LogContext | unknown): Promise<void>
  info(msg: string, ctx?: LogContext | unknown): Promise<void>
  warn(msg: string, ctx?: LogContext | unknown): Promise<void>
  error(msg: string, ctx?: LogContext | unknown): Promise<void>
  child(bindings: { module: string; [k: string]: unknown }): Logger
}

const FRAME_RE = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/

function isInternalFile(file: string): boolean {
  return (
    file.startsWith("node:") ||
    file.includes("/internal/") ||
    file.endsWith("/log.js") ||
    file.endsWith("/log.ts")
  )
}

function parseTopFrame(stack: string | undefined): {
  file?: string
  line?: number
  column?: number
  function?: string
} {
  if (!stack) return {}
  const lines = stack.split("\n")
  for (const raw of lines) {
    const m = FRAME_RE.exec(raw)
    if (!m) continue
    const file = m[2]
    if (isInternalFile(file)) continue
    return {
      function: m[1] || undefined,
      file,
      line: Number(m[3]),
      column: Number(m[4]),
    }
  }
  return {}
}

function nonErrorMessage(value: unknown): string {
  try {
    if (typeof value === "string") return value
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) {
    return { name: "NonError", message: nonErrorMessage(err) }
  }
  try {
    const stack = err.stack
    const frame = parseTopFrame(stack)
    const out: SerializedError = {
      name: err.name,
      message: err.message,
      ...(stack ? { stack } : {}),
      ...frame,
    }
    const code = (err as { code?: string | number }).code
    if (code !== undefined) out.code = code
    const cause = (err as { cause?: unknown }).cause
    if (cause instanceof Error) {
      out.cause = {
        name: cause.name,
        message: cause.message,
        ...(cause.stack ? { stack: cause.stack } : {}),
        ...parseTopFrame(cause.stack),
        ...((cause as { code?: string | number }).code !== undefined
          ? { code: (cause as unknown as { code: string | number }).code }
          : {}),
      }
    }
    return out
  } catch {
    return { name: err.name ?? "Error", message: err.message ?? "" }
  }
}

interface OpencodeClient {
  app: {
    log: (req: {
      body: { service: string; level: LogLevel; message: string; extra?: unknown }
    }) => Promise<unknown>
  }
}

export function createLogger(client: OpencodeClient, service: string): Logger {
  return makeLogger(client, service, undefined)
}

function makeLogger(
  client: OpencodeClient,
  service: string,
  bindings: Record<string, unknown> | undefined,
): Logger {
  async function emit(
    level: LogLevel,
    message: string,
    ctx?: LogContext | unknown,
  ): Promise<void> {
    try {
      const body: {
        service: string
        level: LogLevel
        message: string
        extra?: unknown
      } = { service, level, message }
      const extra = buildExtra(ctx, bindings)
      if (extra !== undefined) body.extra = extra
      await client.app.log({ body })
    } catch {
      // Logger must never throw.
    }
  }
  const logger: Logger = {
    debug: (m, e) => emit("debug", m, e),
    info:  (m, e) => emit("info",  m, e),
    warn:  (m, e) => emit("warn",  m, e),
    error: (m, e) => emit("error", m, e),
    child(b) {
      const merged = { ...(bindings ?? {}), ...b }
      return makeLogger(client, service, merged)
    },
  }
  return logger
}

function buildExtra(
  ctx: LogContext | unknown,
  bindings: Record<string, unknown> | undefined,
): unknown {
  try {
    let normalized: Record<string, unknown> | undefined
    if (ctx instanceof Error) {
      normalized = { error: serializeError(ctx) }
    } else if (ctx !== undefined && ctx !== null && typeof ctx === "object") {
      const obj = ctx as Record<string, unknown>
      normalized = { ...obj }
      if (obj.error instanceof Error) {
        normalized.error = serializeError(obj.error)
      }
    } else if (ctx !== undefined) {
      normalized = { value: ctx }
    }
    if (bindings && Object.keys(bindings).length > 0) {
      normalized = { ...(normalized ?? {}), bindings: { ...bindings } }
    }
    if (normalized === undefined) return undefined
    return truncatePayload(redact(normalized))
  } catch {
    return bindings ? { bindings: { ...bindings } } : undefined
  }
}
