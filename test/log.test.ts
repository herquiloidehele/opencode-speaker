import { describe, it, expect, vi } from "vitest"
import { createLogger, redact, serializeError, truncatePayload } from "../src/log.js"

describe("redact", () => {
  it("masks apiKey-like fields recursively", () => {
    const input = {
      provider: "openai",
      openai: { apiKey: "sk-secret-123", model: "tts-1" },
      elevenlabs: { apiKey: "el-456", voiceId: "abc" },
      narrator: { model: "haiku" },
    }
    expect(redact(input)).toEqual({
      provider: "openai",
      openai: { apiKey: "***", model: "tts-1" },
      elevenlabs: { apiKey: "***", voiceId: "abc" },
      narrator: { model: "haiku" },
    })
  })

  it("masks Authorization headers", () => {
    expect(redact({ headers: { Authorization: "Bearer xyz" } })).toEqual({
      headers: { Authorization: "***" },
    })
  })

  it("returns primitives unchanged", () => {
    expect(redact("hello")).toBe("hello")
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
  })
})

describe("createLogger", () => {
  it("forwards info to client.app.log with redacted extras", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const logger = createLogger(client, "test-service")
    await logger.info("hello", { apiKey: "secret" })
    expect(log).toHaveBeenCalledWith({
      body: {
        service: "test-service",
        level: "info",
        message: "hello",
        extra: { apiKey: "***" },
      },
    })
  })

  it("never throws when client.app.log fails", async () => {
    const log = vi.fn().mockRejectedValue(new Error("network"))
    const client = { app: { log } } as any
    const logger = createLogger(client, "test-service")
    await expect(logger.warn("oops")).resolves.toBeUndefined()
  })
})

describe("serializeError", () => {
  it("returns name, message, stack for a standard Error", () => {
    const err = new Error("boom")
    const out = serializeError(err)
    expect(out.name).toBe("Error")
    expect(out.message).toBe("boom")
    expect(typeof out.stack).toBe("string")
    expect(out.stack).toContain("boom")
  })

  it("extracts file, line, column, function from the top non-internal frame", () => {
    const err = new Error("x")
    err.stack =
      "Error: x\n" +
      "    at Object.<anonymous> (node:internal/foo:10:1)\n" +
      "    at handleEvent (/abs/path/src/dispatcher.ts:142:17)\n" +
      "    at next (/abs/path/src/queue/speech-queue.ts:99:5)\n"
    const out = serializeError(err)
    expect(out.file).toBe("/abs/path/src/dispatcher.ts")
    expect(out.line).toBe(142)
    expect(out.column).toBe(17)
    expect(out.function).toBe("handleEvent")
  })

  it("includes code when present", () => {
    const err: any = new Error("nope")
    err.code = "ENOENT"
    expect(serializeError(err).code).toBe("ENOENT")
  })

  it("recurses into nested causes with a depth limit", () => {
    const root = new Error("root")
    const wrapped = new Error("wrapped", { cause: root })
    const out = serializeError(wrapped)
    expect(out.cause?.message).toBe("root")
    const deeper = new Error("deeper", { cause: new Error("deepest") })
    const wrap2 = new Error("outer", { cause: deeper })
    const out2 = serializeError(wrap2)
    expect(out2.cause?.message).toBe("deeper")
    expect(out2.cause?.cause?.message).toBe("deepest")
  })

  it("handles non-Error throws (string)", () => {
    expect(serializeError("oops")).toEqual({ name: "NonError", message: "oops" })
  })

  it("handles non-Error throws (number)", () => {
    expect(serializeError(42)).toEqual({ name: "NonError", message: "42" })
  })

  it("handles non-Error throws (plain object)", () => {
    expect(serializeError({ a: 1 })).toEqual({ name: "NonError", message: '{"a":1}' })
  })

  it("handles a stack with no non-internal frames", () => {
    const err = new Error("x")
    err.stack = "Error: x\n    at Object.<anonymous> (node:internal/foo:10:1)\n"
    const out = serializeError(err)
    expect(out.file).toBeUndefined()
    expect(out.line).toBeUndefined()
    expect(out.function).toBeUndefined()
  })

  it("never throws when given a getter that throws", () => {
    const evil = new Error("e")
    Object.defineProperty(evil, "stack", {
      get() { throw new Error("inner") },
    })
    expect(() => serializeError(evil)).not.toThrow()
  })
})

describe("redact cycle safety", () => {
  it("handles circular references without infinite looping", () => {
    const a: any = { name: "a" }
    a.self = a
    const out = redact(a) as any
    expect(out.name).toBe("a")
    expect(out.self).toBe("[Circular]")
  })

  it("handles two objects pointing at each other", () => {
    const a: any = { tag: "a" }
    const b: any = { tag: "b", ref: a }
    a.ref = b
    const out = redact(a) as any
    expect(out.tag).toBe("a")
    expect(out.ref.tag).toBe("b")
    expect(out.ref.ref).toBe("[Circular]")
  })

  it("still masks sensitive keys when traversing", () => {
    const root: any = { apiKey: "secret", nested: {} }
    root.nested.parent = root
    const out = redact(root) as any
    expect(out.apiKey).toBe("***")
    expect(out.nested.parent).toBe("[Circular]")
  })
})

describe("truncatePayload", () => {
  it("truncates long string fields", () => {
    const big = "x".repeat(5000)
    const out = truncatePayload({ field: big }) as any
    expect(out.field).toMatch(/<truncated:\d+ bytes>$/)
    expect(out.field.length).toBeLessThan(big.length)
  })

  it("does not truncate error.stack", () => {
    const big = "S".repeat(20000)
    const out = truncatePayload({ error: { stack: big, message: "m", name: "E" } }) as any
    expect(out.error.stack).toBe(big)
    expect(out.error.stack).not.toMatch(/<truncated/)
  })

  it("truncates other fields inside error (e.g. message)", () => {
    const longMessage = "M".repeat(8000)
    const out = truncatePayload({ error: { stack: "short", message: longMessage, name: "E" } }) as any
    expect(out.error.message).toMatch(/<truncated:\d+ bytes>$/)
  })

  it("leaves small strings alone", () => {
    expect(truncatePayload({ a: "hi" })).toEqual({ a: "hi" })
  })

  it("walks nested objects and arrays", () => {
    const big = "z".repeat(5000)
    const out = truncatePayload({ a: { b: [big] } }) as any
    expect(out.a.b[0]).toMatch(/<truncated:\d+ bytes>$/)
  })
})

describe("createLogger smart emit", () => {
  it("auto-serializes ctx.error when it is an Error", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const logger = createLogger(client, "svc")
    const err = new Error("boom")
    await logger.error("oh no", { error: err, operation: "x", input: { a: 1 } })
    const payload = log.mock.calls[0][0].body.extra
    expect(payload.error.name).toBe("Error")
    expect(payload.error.message).toBe("boom")
    expect(payload.error.stack).toContain("boom")
    expect(payload.operation).toBe("x")
    expect(payload.input).toEqual({ a: 1 })
  })

  it("auto-serializes ctx itself when it is an Error", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const logger = createLogger(client, "svc")
    await logger.error("oh no", new Error("plain"))
    const payload = log.mock.calls[0][0].body.extra
    expect(payload.error.name).toBe("Error")
    expect(payload.error.message).toBe("plain")
  })

  it("redacts sensitive keys inside input even when error is also present", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const logger = createLogger(client, "svc")
    await logger.error("x", { error: new Error("e"), input: { apiKey: "sk" } })
    expect(log.mock.calls[0][0].body.extra.input.apiKey).toBe("***")
  })

  it("preserves the legacy (msg, extra: object) shape", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const logger = createLogger(client, "svc")
    await logger.info("hi", { apiKey: "secret", other: "ok" })
    expect(log.mock.calls[0][0].body.extra.apiKey).toBe("***")
    expect(log.mock.calls[0][0].body.extra.other).toBe("ok")
  })

  it("works with no ctx", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const logger = createLogger(client, "svc")
    await logger.info("plain")
    expect(log.mock.calls[0][0].body).toEqual({
      service: "svc",
      level: "info",
      message: "plain",
    })
  })

  it("never throws when serialization throws on an evil ctx", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const logger = createLogger(client, "svc")
    const evil: any = {}
    Object.defineProperty(evil, "input", {
      get() { throw new Error("inner") },
      enumerable: true,
    })
    await expect(logger.error("x", evil)).resolves.toBeUndefined()
  })
})

describe("logger.child", () => {
  it("adds bindings.module to every emitted payload", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const root = createLogger(client, "svc")
    const child = root.child({ module: "queue" })
    await child.info("hi")
    expect(log.mock.calls[0][0].body.extra).toEqual({
      bindings: { module: "queue" },
    })
  })

  it("merges bindings with provided ctx", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const child = createLogger(client, "svc").child({ module: "queue" })
    await child.info("hi", { operation: "x" })
    const extra = log.mock.calls[0][0].body.extra
    expect(extra.bindings.module).toBe("queue")
    expect(extra.operation).toBe("x")
  })

  it("child-of-child concatenates bindings", async () => {
    const log = vi.fn().mockResolvedValue(undefined)
    const client = { app: { log } } as any
    const root = createLogger(client, "svc")
    const a = root.child({ module: "queue" })
    const b = a.child({ module: "queue", voiceId: "alloy" })
    await b.info("hi")
    expect(log.mock.calls[0][0].body.extra.bindings).toEqual({
      module: "queue",
      voiceId: "alloy",
    })
  })
})
