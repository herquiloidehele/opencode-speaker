# Enriched Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `String(err)` everywhere with structured error logging that captures `name`, `code`, `stack`, `file`, `line`, `function`, plus per-call `operation` and `input` context, with stacks source-map-resolved to `src/*.ts`.

**Architecture:** Extend `src/log.ts` with a `SerializedError` type, a `serializeError(err)` helper, a smart `logger.error(msg, ctx)` that auto-serializes any Error in `ctx`, and `logger.child({ module })` for per-subsystem tagging. Install `source-map-support` at the plugin entry so error stacks resolve to TypeScript source. Migrate all existing call sites in `src/index.ts` to the new shape. Inject child loggers into `Dispatcher`, `SpeechQueue`, and `Narrator` (the three subsystems with meaningful internal catches) so they log directly with full local context while keeping their existing `onError` callbacks intact.

**Tech Stack:** TypeScript (ESM), `tsup`, `vitest`, `source-map-support` (new dep).

**Spec:** `docs/superpowers/specs/2026-05-31-enriched-logging-design.md`

---

## File Structure

### Files modified

- `src/log.ts` — Major rewrite. Adds `SerializedError`, `LogContext`, `serializeError`, smart emit, truncation, cycle-safe redact, `child()`. Keeps `redact()` and `createLogger()` exports working.
- `src/index.ts` — Add `source-map-support/register` import as the first import. Create child loggers (`initLog`, `dispatchLog`, `queueLog`, `narratorLog`, `audioLog`, `ttsLog`). Replace every `error: String(err)` with `error: err` and add `operation` + `input` per call. Pass child loggers into Dispatcher, SpeechQueue, and Narrator constructors.
- `src/dispatcher.ts` — Add `logger: Logger` to `DispatcherOptions`. In the `fire()` catch, call `logger.warn` with rich context BEFORE invoking `onError`. Keep `onError` semantics intact.
- `src/queue/speech-queue.ts` — Add `logger: Logger` to `SpeechQueueOptions`. In the `pump()` catch, call `logger.warn` with the request snapshot BEFORE invoking `onError`. Keep `onError` semantics intact.
- `src/handlers/narrator.ts` — Add `logger: Logger` parameter to `createNarrator()`. Upgrade the silent `catch { return null }` at line 77 to call `logger.warn` with full context, then return `null`.
- `tsup.config.ts` — Change `sourcemap: true` → `sourcemap: "inline"`.
- `package.json` — Add `source-map-support` to `dependencies`, `@types/source-map-support` to `devDependencies`.
- `test/log.test.ts` — Add tests for `serializeError`, smart emit, child loggers, truncation, cycle safety, non-Error throws, robustness.
- `test/dispatcher.test.ts` — Add test asserting `logger.warn` is called with `{ error, operation, input: { eventType, partID } }` when a handler throws.
- `test/speech-queue.test.ts` — Add test asserting `logger.warn` is called with `{ error, operation, input: { textPreview, voice, priority } }` when `speak` throws.
- `test/handlers-narrator.test.ts` — Add test asserting `logger.warn` is called when `generateText` throws AND `summarize` still returns `null`.

### Files created

- `test/log.source-maps.test.ts` — E2E: throw an Error from a function defined on a known line in this test file, install `source-map-support/register`, run `serializeError`, assert the extracted `file` ends with the test filename and `line` matches the line the error was thrown from.

### Files NOT modified (and why — divergences from spec §8.2)

- `src/audio/runner.ts` — The `catch { /* keep searching */ }` at line 34 is intentional PATH-iteration logic, not a silent error swallower. The `run()` function rejects cleanly on real errors. Its callers (`src/audio/player.ts`, `src/index.ts`) already surface those errors. No logger injection needed.
- `src/audio/player.ts` — `init()` and `play()` throw clean `Error` instances. The caller (`src/index.ts` lines 119–129) catches and logs them; after this work, that catch will use the new structured shape with `audioLog` (module tag `"audio"`). No internal logger injection needed.
- `src/tts/provider.ts` — Just a `Map` registry. No errors to log.
- `src/tts/ai-sdk.ts` — `init()` and `synthesize()` throw clean errors. Caller in `src/index.ts` (init) and the `SpeechQueue.pump()` path (synthesize) catch them; new logging at those boundaries uses `ttsLog`. No internal logger injection needed.

The spec's §8.2 table aspirationally listed 7 files; this plan limits injection to the 3 that have meaningful internal catches (dispatcher, queue, narrator). All 5 logical modules (`init`, `dispatcher`, `queue`, `narrator`, `audio`, `tts`) still appear in logs via `bindings.module` because the child loggers are created in `src/index.ts` and used at the appropriate boundary.

---

## Coding Conventions

- **No comments unless they explain non-obvious "why".** Match the existing code style — the codebase uses sparse comments only where intent isn't clear from code. Don't add JSDoc to every function. Don't restate what the code does.
- **No emojis** in code, tests, commit messages, or documentation.
- **Match existing formatting** — 2-space indent, double quotes for strings, no semicolons-required (the existing files do have semicolons; check before each edit and match).
- **Import style** — use `.js` extensions on relative imports (project is ESM): `import { x } from "./y.js"`.
- **TypeScript strictness** — match what the codebase already does. Don't add `any` casts beyond what's already there.

---

## Task 1: Source-map plumbing (build + runtime)

**Files:**
- Modify: `tsup.config.ts`
- Modify: `package.json`
- Modify: `src/index.ts:1-18` (add new first import)

- [ ] **Step 1: Install `source-map-support`**

Run:
```bash
npm install --save source-map-support
npm install --save-dev @types/source-map-support
```

Expected: both packages added to `package.json` under the correct sections. Verify with `cat package.json | grep -A1 source-map-support`.

- [ ] **Step 2: Switch tsup to inline source maps**

Edit `tsup.config.ts`. Change the `sourcemap: true` line to `sourcemap: "inline"`:

```ts
import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/api.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: "inline",
})
```

- [ ] **Step 3: Register source-map-support at plugin entry**

Edit `src/index.ts`. Add `import "source-map-support/register"` as the **very first line** of the file, before all other imports:

```ts
import "source-map-support/register"
import { z } from "zod"
import { parseConfig, PLUGIN_NAME } from "./config.js"
import { createLogger } from "./log.js"
// ... rest of existing imports unchanged
```

- [ ] **Step 4: Verify build still works**

Run: `npm run build`
Expected: tsup output ends with `DTS ⚡` and `Build success`. No errors. `dist/index.js` exists and contains an inline source map (string `//# sourceMappingURL=data:application/json;base64,` near the end of the file).

- [ ] **Step 5: Verify typecheck**

Run: `npm run typecheck`
Expected: no output (success).

- [ ] **Step 6: Verify existing tests still pass**

Run: `npm test`
Expected: all tests pass (no test changes yet).

- [ ] **Step 7: Commit**

```bash
git add tsup.config.ts package.json package-lock.json src/index.ts
git commit -m "build: enable inline source maps and register source-map-support"
```

---

## Task 2: Add SerializedError + LogContext types

**Files:**
- Modify: `src/log.ts:17-24` (extend interfaces)

This task is types-only; no behavior change. Tests for the new behavior arrive in Tasks 3–5.

- [ ] **Step 1: Replace the `Logger` interface block with the enriched types**

Edit `src/log.ts`. Replace lines 17–24 (the `LogLevel` and `Logger` block) with:

```ts
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
```

Leave the `SENSITIVE_KEYS`, `redact`, `OpencodeClient`, and `createLogger` blocks untouched for now.

- [ ] **Step 2: Add a placeholder `child` method so the interface compiles**

The existing `createLogger` returns an object that does not yet implement `child`. Add a temporary stub at the bottom of the returned object so the type still satisfies the interface:

Edit the `return {` block at the bottom of `createLogger` to:

```ts
  const logger: Logger = {
    debug: (m, e) => emit("debug", m, e),
    info:  (m, e) => emit("info",  m, e),
    warn:  (m, e) => emit("warn",  m, e),
    error: (m, e) => emit("error", m, e),
    child: () => logger,
  }
  return logger
```

(`child: () => logger` is a placeholder — Task 5 replaces it with real bindings logic.)

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no output (success). If there are type errors at any call site that already does `extra?: unknown`, they should still type-check because `LogContext | unknown` reduces to `unknown`.

- [ ] **Step 4: Verify tests**

Run: `npm test`
Expected: all existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts
git commit -m "log: introduce SerializedError, LogContext, and child() in types"
```

---

## Task 3: `serializeError` helper (TDD)

**Files:**
- Test: `test/log.test.ts` (add tests)
- Modify: `src/log.ts` (add `serializeError` export)

- [ ] **Step 1: Write failing tests for `serializeError`**

Append to `test/log.test.ts`:

```ts
import { serializeError } from "../src/log.js"

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

  it("recurses one level into cause", () => {
    const root = new Error("root")
    const wrapped = new Error("wrapped", { cause: root })
    const out = serializeError(wrapped)
    expect(out.cause?.message).toBe("root")
    // Does not recurse further: cause.cause is undefined even if root had one.
    const deeper = new Error("deeper", { cause: new Error("deepest") })
    const wrap2 = new Error("outer", { cause: deeper })
    const out2 = serializeError(wrap2)
    expect(out2.cause?.message).toBe("deeper")
    expect((out2.cause as any).cause).toBeUndefined()
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/log.test.ts`
Expected: 8 new tests in `serializeError` block all FAIL with `serializeError is not a function` or similar import error.

- [ ] **Step 3: Implement `serializeError`**

Edit `src/log.ts`. Add this function block immediately above the `OpencodeClient` interface (around the current line 26):

```ts
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
          ? { code: (cause as { code: string | number }).code }
          : {}),
      }
    }
    return out
  } catch {
    return { name: err.name ?? "Error", message: err.message ?? "" }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/log.test.ts`
Expected: all `serializeError` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "log: add serializeError with top-frame extraction and cause preservation"
```

---

## Task 4: Cycle-safe redact and truncation (TDD)

**Files:**
- Test: `test/log.test.ts`
- Modify: `src/log.ts` (extend `redact`, add `truncate`)

- [ ] **Step 1: Write failing tests**

Append to `test/log.test.ts`:

```ts
import { truncatePayload } from "../src/log.js"

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/log.test.ts`
Expected: circular tests FAIL (current `redact` would infinite-loop — Vitest will report timeout or stack overflow). `truncatePayload` tests FAIL with import error.

- [ ] **Step 3: Replace `redact` with a cycle-safe version**

Edit `src/log.ts`. Replace the existing `redact` function (lines 7–15) with:

```ts
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
```

- [ ] **Step 4: Add `truncatePayload`**

Add to `src/log.ts` immediately after `redact`/`redactInner`:

```ts
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
    const exempt = k === "stack" // exempt error.stack — but only when the field name itself is "stack"
    out[k] = truncateInner(v, seen, exempt)
  }
  return out
}
```

Note: the `insideErrorStack` flag is propagated down so any nested `stack` string is exempt, but ONLY the value at the `stack` field is — siblings like `message` still get truncated.

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/log.test.ts`
Expected: all redact + truncatePayload tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "log: cycle-safe redact and per-field truncation (stack exempt)"
```

---

## Task 5: Smart `emit` + `child()` (TDD)

**Files:**
- Test: `test/log.test.ts`
- Modify: `src/log.ts` (rewrite emit + child)

- [ ] **Step 1: Write failing tests**

Append to `test/log.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/log.test.ts`
Expected: the new `createLogger smart emit` and `logger.child` blocks FAIL — `payload.error` is the literal Error object, `child` is a placeholder no-op (returns logger without bindings).

- [ ] **Step 3: Rewrite `createLogger` with smart emit and real child bindings**

Edit `src/log.ts`. Replace the entire `createLogger` function (currently ends at line 55-ish; line numbers will have shifted from earlier tasks) with:

```ts
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
    // Serialization itself failed — return a minimal payload so we still log SOMETHING.
    return bindings ? { bindings: { ...bindings } } : undefined
  }
}
```

Then delete the temporary `child: () => logger` placeholder from Task 2 if it still exists.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/log.test.ts`
Expected: all log tests PASS — including the original 3 redact + 2 createLogger tests, plus the 8 serializeError tests from Task 3, 6 redact/truncate tests from Task 4, and 9 new emit/child tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass — existing callers still work because `(msg, extra)` callers like `logger.info("hi", { apiKey: "secret" })` flow through `buildExtra` as the legacy path.

- [ ] **Step 6: Commit**

```bash
git add src/log.ts test/log.test.ts
git commit -m "log: smart emit auto-serializes Errors and supports child loggers"
```

---

## Task 6: Source-map E2E test

**Files:**
- Create: `test/log.source-maps.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/log.source-maps.test.ts`:

```ts
import "source-map-support/register"
import { describe, it, expect } from "vitest"
import { serializeError } from "../src/log.js"

function throwHere(): never {
  throw new Error("source-map probe")
}

describe("serializeError with source maps", () => {
  it("resolves stack frames to the TypeScript source file", () => {
    let captured: Error | null = null
    try {
      throwHere()
    } catch (e) {
      captured = e as Error
    }
    expect(captured).not.toBeNull()
    const out = serializeError(captured!)
    expect(out.file ?? "").toMatch(/log\.source-maps\.test\.ts$/)
    expect(typeof out.line).toBe("number")
    expect(out.function ?? "").toMatch(/throwHere/)
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run test/log.source-maps.test.ts`
Expected: PASS. Vitest runs the TS source directly via its TypeScript loader, so the resolver path is genuinely exercised. If it fails because the file path looks like `.../test/log.source-maps.test.ts` rather than something with `src/`, that's still a success — the assertion only requires it to end with the test filename.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/log.source-maps.test.ts
git commit -m "test: source-map-resolved stack frames end-to-end"
```

---

## Task 7: Migrate `src/index.ts` boot path to the new shape

**Files:**
- Modify: `src/index.ts` (boot path, lines 40–115)

This task only touches the initialization section (top-level catch + config + model resolution + TTS init + provider lookup). Event-handler call sites come in Task 8.

- [ ] **Step 1: Add child-logger creation right after the root logger is created**

Edit `src/index.ts`. After line 57 (`const logger = createLogger(ctx.client as any, PLUGIN_NAME)`), add:

```ts
  const initLog     = logger.child({ module: "init" })
  const dispatchLog = logger.child({ module: "dispatcher" })
  const queueLog    = logger.child({ module: "queue" })
  const narratorLog = logger.child({ module: "narrator" })
  const audioLog    = logger.child({ module: "audio" })
  const ttsLog      = logger.child({ module: "tts" })
```

Note: `dispatchLog`, `queueLog`, and `narratorLog` are created here but their non-trivial usage happens in Tasks 9–11. We declare them up-front so the rest of this file can reference them.

- [ ] **Step 2: Update the outer top-level catch (currently lines 40–53)**

Replace the existing block:

```ts
export const OpencodeSpeaker = async (ctx: PluginCtx, options?: PluginOptions) => {
  try {
    return await initPlugin(ctx, options)
  } catch (err) {
    try {
      const logger = createLogger(ctx.client as any, PLUGIN_NAME)
      await logger.error(`${PLUGIN_NAME} failed to initialize; plugin disabled`, {
        error: String(err),
      })
    } catch {
      /* logger itself failed; nothing we can safely do */
    }
    return {}
  }
}
```

with:

```ts
export const OpencodeSpeaker = async (ctx: PluginCtx, options?: PluginOptions) => {
  try {
    return await initPlugin(ctx, options)
  } catch (err) {
    try {
      const logger = createLogger(ctx.client as any, PLUGIN_NAME).child({ module: "init" })
      await logger.error(`${PLUGIN_NAME} failed to initialize; plugin disabled`, {
        error: err,
        operation: "initializing plugin",
      })
    } catch {
      /* logger itself failed; nothing we can safely do */
    }
    return {}
  }
}
```

- [ ] **Step 3: Update the "invalid config" log (line 65)**

Replace:

```ts
    await logger.error("Invalid voice config; plugin disabled", { errors: parsed.errors })
```

with:

```ts
    await initLog.error("Invalid voice config; plugin disabled", {
      operation: "parsing plugin config",
      input: { errors: parsed.errors },
    })
```

- [ ] **Step 4: Update the "disabled by config" info log (line 71)**

Replace:

```ts
    await logger.info(`${PLUGIN_NAME} disabled by config or env`)
```

with:

```ts
    await initLog.info(`${PLUGIN_NAME} disabled by config or env`, {
      operation: "starting plugin",
    })
```

- [ ] **Step 5: Update the "invalid model slug" + "failed to resolve models" block (lines 82–88)**

Replace:

```ts
    if (err instanceof ConfigError) {
      await logger.error(`Invalid model slug; plugin disabled: ${err.message}`)
    } else {
      await logger.error("Failed to resolve models; plugin disabled", {
        error: String(err),
      })
    }
```

with:

```ts
    if (err instanceof ConfigError) {
      await initLog.error("Invalid model slug; plugin disabled", {
        error: err,
        operation: "resolving model slugs",
        input: { narrator: config.narrator.model, tts: config.tts.model },
      })
    } else {
      await initLog.error("Failed to resolve models; plugin disabled", {
        error: err,
        operation: "resolving model slugs",
        input: { narrator: config.narrator.model, tts: config.tts.model },
      })
    }
```

- [ ] **Step 6: Update the "failed to initialize TTS provider" log (line 101)**

Replace:

```ts
  } catch (err) {
    await logger.error("Failed to initialize TTS provider; plugin disabled", {
      error: String(err),
    })
    return {}
  }
```

with:

```ts
  } catch (err) {
    await ttsLog.error("Failed to initialize TTS provider; plugin disabled", {
      error: err,
      operation: "initializing TTS provider",
      input: { provider: resolvedSpeech.provider, voice: config.tts.voice },
    })
    return {}
  }
```

- [ ] **Step 7: Update the "provider not found" log (line 110)**

Replace:

```ts
  if (!provider) {
    await logger.error(
      `TTS provider not found after registration: ${resolvedSpeech.provider}`,
    )
    return {}
  }
```

with:

```ts
  if (!provider) {
    await ttsLog.error("TTS provider not found after registration; plugin disabled", {
      operation: "looking up TTS provider after init",
      input: { provider: resolvedSpeech.provider },
    })
    return {}
  }
```

- [ ] **Step 8: Update the "audio player unavailable" log (lines 123–127)**

Replace:

```ts
  } catch (err) {
    await logger.warn(
      "Audio player unavailable; cloud providers may not produce output",
      { error: String(err) },
    )
    player = null
  }
```

with:

```ts
  } catch (err) {
    await audioLog.warn(
      "Audio player unavailable; cloud providers may not produce output",
      {
        error: err,
        operation: "initializing audio player",
        input: { platform: process.platform },
      },
    )
    player = null
  }
```

- [ ] **Step 9: Update the "audio produced but no player" log (line 143)**

Replace:

```ts
    if (!player) {
      await logger.warn("Audio produced but no player available; dropping audio")
      return
    }
```

with:

```ts
    if (!player) {
      await audioLog.warn("Audio produced but no player available; dropping audio", {
        operation: "playing synthesized audio",
      })
      return
    }
```

- [ ] **Step 10: Update the "ready" info log (line 182)**

Replace:

```ts
  await logger.info(`${PLUGIN_NAME} ready (provider=${resolvedSpeech.provider})`)
```

with:

```ts
  await initLog.info(`${PLUGIN_NAME} ready`, {
    operation: "plugin ready",
    input: { provider: resolvedSpeech.provider, voice: config.tts.voice },
  })
```

- [ ] **Step 11: Verify typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 12: Verify tests**

Run: `npm test`
Expected: all tests pass. The existing `test/index.test.ts` does not assert specific log content, so the migration should not break it. If it does, read the failures carefully — they may indicate a logging contract the test relied on.

- [ ] **Step 13: Commit**

```bash
git add src/index.ts
git commit -m "log: migrate index.ts boot path to structured error logging"
```

---

## Task 8: Migrate `src/index.ts` event-handler call sites

**Files:**
- Modify: `src/index.ts` (lines 154–172 and 240–275)

The boot-path `onError` callbacks for the queue and dispatcher stay in place; Tasks 9 and 10 add the direct subsystem-level logging. Here we just update what the callbacks themselves log (because they currently use `String(err)`).

- [ ] **Step 1: Update the SpeechQueue `onError` callback (line 154)**

Replace:

```ts
    onError: (err, req) => {
      void logger.warn(`speak failed for "${req.text}"`, { error: String(err) })
    },
```

with:

```ts
    onError: (err, req) => {
      void queueLog.warn("speak failed at boundary", {
        error: err,
        operation: "speech-queue onError boundary",
        input: { textPreview: req.text.slice(0, 80), priority: req.priority },
      })
    },
```

(Subsystem-internal logging from inside `SpeechQueue` itself comes in Task 10.)

- [ ] **Step 2: Update the Dispatcher `onError` callback (line 169)**

Replace:

```ts
    onError: (err, e) => {
      void logger.warn(`handler error for ${e.type}`, { error: String(err) })
    },
```

with:

```ts
    onError: (err, e) => {
      void dispatchLog.warn("handler error at boundary", {
        error: err,
        operation: "dispatcher onError boundary",
        input: { eventType: e.type },
      })
    },
```

- [ ] **Step 3: Update the "command event received" log (lines 243–246)**

This is the verbose debug-style log dumping the raw event. We keep the log but rely on truncation (Task 4) to bound the payload size, and we tag the module.

Replace:

```ts
        await logger.info(`voice: command event received`, {
          type: event.type,
          event,
        })
```

with:

```ts
        await initLog.info("voice: command event received", {
          operation: "intercepting TUI command event",
          input: { type: event.type, event },
        })
```

- [ ] **Step 4: Update the shortcut-result log (line 251)**

Replace:

```ts
            await logger.info(`voice shortcut /${name} -> ${result}`)
```

with:

```ts
            await initLog.info("voice shortcut handled", {
              operation: "handling TUI command shortcut",
              input: { name, result },
            })
```

- [ ] **Step 5: Update the shortcut-failure log (line 253)**

Replace:

```ts
          } catch (err) {
            await logger.warn(`voice shortcut /${name} failed`, {
              error: String(err),
            })
          }
```

with:

```ts
          } catch (err) {
            await initLog.warn("voice shortcut failed", {
              error: err,
              operation: "handling TUI command shortcut",
              input: { name },
            })
          }
```

- [ ] **Step 6: Update the "did not match any shortcut" log (line 260)**

Replace:

```ts
        if (name) {
          await logger.info(`voice: command /${name} did not match any shortcut`)
        }
```

with:

```ts
        if (name) {
          await initLog.info("voice: command did not match any shortcut", {
            operation: "intercepting TUI command event",
            input: { name },
          })
        }
```

- [ ] **Step 7: Update the "event handler crashed" log (line 271)**

Replace:

```ts
      try {
        await dispatcher.onEvent(event)
      } catch (err) {
        await logger.warn(`event handler crashed for ${event.type}`, {
          error: String(err),
        })
      }
```

with:

```ts
      try {
        await dispatcher.onEvent(event)
      } catch (err) {
        await dispatchLog.warn("event handler crashed", {
          error: err,
          operation: "dispatching opencode event",
          input: { eventType: event.type },
        })
      }
```

- [ ] **Step 8: Verify there are no remaining `String(err)` uses in src/index.ts**

Run: `rg "String\(err\)" src/index.ts`
Expected: no matches.

- [ ] **Step 9: Verify there are no remaining bare `logger.` references in src/index.ts (only child-prefixed ones)**

Run: `rg "\b(await|void) logger\.(debug|info|warn|error)" src/index.ts`
Expected: only references inside `initPlugin`'s outer-catch fallback in Task 7 (where we use `createLogger(...).child(...)` directly), or zero matches. If there are stragglers like `logger.info(...)` still using the root logger, decide which child should own them and update.

- [ ] **Step 10: Verify typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: pass.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts
git commit -m "log: migrate index.ts event handlers to structured error logging"
```

---

## Task 9: Inject logger into Dispatcher

**Files:**
- Modify: `src/dispatcher.ts`
- Modify: `src/index.ts` (pass `dispatchLog` into `createDispatcher`)
- Modify: `test/dispatcher.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/dispatcher.test.ts`:

```ts
import type { Logger } from "../src/log.js"

function fakeLogger(): { logger: Logger; warns: Array<{ message: string; ctx: any }> } {
  const warns: Array<{ message: string; ctx: any }> = []
  const noop = async () => {}
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: async (m, c) => { warns.push({ message: m, ctx: c }) },
    error: noop,
    child: () => logger,
  }
  return { logger, warns }
}

describe("dispatcher logger injection", () => {
  it("logs handler errors with eventType context BEFORE invoking onError", async () => {
    const { logger, warns } = fakeLogger()
    const handle = vi.fn().mockRejectedValue(new Error("handler boom"))
    const push = vi.fn()
    const onError = vi.fn()
    const d = createDispatcher({
      handler: { handle },
      queue: { push },
      logger,
      onError,
    } as any)
    await d.onEvent({ type: "session.idle" })
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toBe("handler failed")
    expect(warns[0].ctx.error).toBeInstanceOf(Error)
    expect(warns[0].ctx.operation).toBe("dispatching opencode event")
    expect(warns[0].ctx.input).toEqual({ eventType: "session.idle" })
    expect(onError).toHaveBeenCalled()
  })

  it("does not throw when logger is omitted (backwards compatible)", async () => {
    const handle = vi.fn().mockRejectedValue(new Error("x"))
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await expect(d.onEvent({ type: "session.idle" })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/dispatcher.test.ts`
Expected: the new tests FAIL — current dispatcher never calls a logger.

- [ ] **Step 3: Add `logger` to DispatcherOptions and wire it into `fire`**

Edit `src/dispatcher.ts`.

Add to the top of the file, after the existing imports:

```ts
import type { Logger } from "./log.js"
```

Update `DispatcherOptions` (currently lines 9–19) to add `logger`:

```ts
export interface DispatcherOptions {
  handler: HandlerRegistry
  queue: QueueIfc
  logger?: Logger
  onError?: (err: unknown, event: { type: string }) => void
  /** Max chars of recent assistant text to keep. */
  textWindow?: number
  /** Max recent tool calls to remember. */
  toolWindow?: number
  /** Max chars of reasoning buffer before forced flush when no sentence end is found. */
  reasoningFlushChars?: number
}
```

Update the `fire` function (currently lines 76–83) to log before bubbling:

```ts
  async function fire(event: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      const sr = await opts.handler.handle(event)
      if (sr) opts.queue.push(sr)
    } catch (err) {
      if (opts.logger) {
        await opts.logger.warn("handler failed", {
          error: err,
          operation: "dispatching opencode event",
          input: { eventType: event.type },
        })
      }
      opts.onError?.(err, event)
    }
  }
```

- [ ] **Step 4: Pass `dispatchLog` in `src/index.ts`**

Edit `src/index.ts`. Update the `createDispatcher({...})` call (around line 162) to pass `logger: dispatchLog`:

```ts
  const dispatcher = createDispatcher({
    logger: dispatchLog,
    handler: createHandlerRegistry({
      events: config.events as any,
      narrator,
      getContext: () => dispatcher.getContext(),
    }),
    queue,
    onError: (err, e) => {
      void dispatchLog.warn("handler error at boundary", {
        error: err,
        operation: "dispatcher onError boundary",
        input: { eventType: e.type },
      })
    },
  })
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass, including the two new dispatcher tests.

- [ ] **Step 6: Commit**

```bash
git add src/dispatcher.ts src/index.ts test/dispatcher.test.ts
git commit -m "log: inject child logger into Dispatcher with rich event context"
```

---

## Task 10: Inject logger into SpeechQueue

**Files:**
- Modify: `src/queue/speech-queue.ts`
- Modify: `src/index.ts` (pass `queueLog`)
- Modify: `test/speech-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/speech-queue.test.ts`:

```ts
import type { Logger } from "../src/log.js"

function fakeLogger() {
  const warns: Array<{ message: string; ctx: any }> = []
  const noop = async () => {}
  const logger: Logger = {
    debug: noop, info: noop, error: noop,
    warn: async (m, c) => { warns.push({ message: m, ctx: c }) },
    child: () => logger,
  }
  return { logger, warns }
}

describe("speech-queue logger injection", () => {
  it("logs speak failures with text preview + voice + priority context", async () => {
    const { logger, warns } = fakeLogger()
    const speak = vi.fn().mockRejectedValue(new Error("synth boom"))
    const onError = vi.fn()
    const q = new SpeechQueue({
      speak,
      staleMs: 60_000,
      now: () => 0,
      onError,
      logger,
    } as any)
    q.push({
      id: "1",
      priority: 2,
      text: "Hello world this is a test sentence about logging",
      enqueuedAt: 0,
    } as any)
    await q.idle()
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toBe("speak failed")
    expect(warns[0].ctx.error).toBeInstanceOf(Error)
    expect(warns[0].ctx.operation).toBe("synthesizing queued speech")
    expect(warns[0].ctx.input.textPreview).toMatch(/^Hello world/)
    expect(warns[0].ctx.input.priority).toBe(2)
    expect(onError).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/speech-queue.test.ts`
Expected: new test FAILS — queue does not call a logger today.

- [ ] **Step 3: Update SpeechQueueOptions and `pump()`**

Edit `src/queue/speech-queue.ts`. Add an import for `Logger`:

```ts
import { Priority, type SpeechRequest } from "./types.js"
import type { Logger } from "../log.js"
```

Extend `SpeechQueueOptions`:

```ts
export interface SpeechQueueOptions {
  speak: SpeakFn
  staleMs: number
  now: () => number
  onError?: (err: unknown, req: SpeechRequest) => void
  logger?: Logger
}
```

Update the catch block in `pump()` (around line 101). Replace:

```ts
        try {
          await this.opts.speak(next, abort.signal)
        } catch (err) {
          this.opts.onError?.(err, next)
        } finally {
          this.current = null
        }
```

with:

```ts
        try {
          await this.opts.speak(next, abort.signal)
        } catch (err) {
          if (this.opts.logger) {
            await this.opts.logger.warn("speak failed", {
              error: err,
              operation: "synthesizing queued speech",
              input: {
                textPreview: next.text.slice(0, 80),
                priority: next.priority,
                enqueuedAt: next.enqueuedAt,
              },
            })
          }
          this.opts.onError?.(err, next)
        } finally {
          this.current = null
        }
```

- [ ] **Step 4: Pass `queueLog` in `src/index.ts`**

Edit `src/index.ts`. Update the `new SpeechQueue({...})` call (around line 150) to include `logger: queueLog`:

```ts
  const queue = new SpeechQueue({
    speak,
    staleMs: config.queue.staleMs,
    now: () => Date.now(),
    logger: queueLog,
    onError: (err, req) => {
      void queueLog.warn("speak failed at boundary", {
        error: err,
        operation: "speech-queue onError boundary",
        input: { textPreview: req.text.slice(0, 80), priority: req.priority },
      })
    },
  })
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all tests pass, including the new SpeechQueue test.

- [ ] **Step 6: Commit**

```bash
git add src/queue/speech-queue.ts src/index.ts test/speech-queue.test.ts
git commit -m "log: inject child logger into SpeechQueue with request snapshot"
```

---

## Task 11: Inject logger into Narrator + upgrade silent catch

**Files:**
- Modify: `src/handlers/narrator.ts`
- Modify: `src/index.ts` (pass `narratorLog`)
- Modify: `test/handlers-narrator.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/handlers-narrator.test.ts`:

```ts
import type { Logger } from "../src/log.js"

function fakeLogger() {
  const warns: Array<{ message: string; ctx: any }> = []
  const noop = async () => {}
  const logger: Logger = {
    debug: noop, info: noop, error: noop,
    warn: async (m, c) => { warns.push({ message: m, ctx: c }) },
    child: () => logger,
  }
  return { logger, warns }
}

describe("narrator logger injection", () => {
  it("logs and returns null when the language model throws", async () => {
    const { logger, warns } = fakeLogger()
    // A LanguageModel that always rejects.
    const model: any = {
      doGenerate: async () => { throw new Error("LM down") },
    }
    const narrator = createNarrator(model, { timeoutMs: 100, minIntervalMs: 0 }, logger)
    const result = await narrator.summarize(
      { type: "todo.completed.all" },
      { assistantText: "wrote some code", recentTools: ["write"] },
    )
    expect(result).toBeNull()
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toBe("narrator summary failed")
    expect(warns[0].ctx.error).toBeInstanceOf(Error)
    expect(warns[0].ctx.operation).toBe("summarizing event for narration")
    expect(warns[0].ctx.input.eventType).toBe("todo.completed.all")
  })

  it("works without a logger (backwards compatible)", async () => {
    const model: any = {
      doGenerate: async () => { throw new Error("x") },
    }
    const narrator = createNarrator(model, { timeoutMs: 100, minIntervalMs: 0 })
    const result = await narrator.summarize(
      { type: "session.idle" },
      { assistantText: "", recentTools: [] },
    )
    expect(result).toBeNull()
  })
})
```

Note: the `createNarrator` signature changes from `(model, config)` to `(model, config, logger?)`. The test above passes the logger as the 3rd arg. Vitest may need the existing narrator tests to also tolerate the new optional arg — they should, because it's optional.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/handlers-narrator.test.ts`
Expected: the new logger-injection test FAILS (third arg ignored; no warn recorded). The backwards-compatible test PASSES — `summarize` already returns null when the model throws.

- [ ] **Step 3: Update `createNarrator`**

Edit `src/handlers/narrator.ts`. Add a `Logger` import at the top:

```ts
import { generateText, type LanguageModel } from "ai"
import { truncate } from "./template.js"
import type { Logger } from "../log.js"
```

Change `createNarrator`'s signature and the silent catch:

```ts
export function createNarrator(
  model: LanguageModel,
  config: NarratorConfig,
  logger?: Logger,
): Narrator {
  let lastFinishedAt = 0

  return {
    async summarize(event, ctx) {
      const now = Date.now()
      if (now - lastFinishedAt < config.minIntervalMs) return null

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), config.timeoutMs)
      try {
        const { text } = await generateText({
          model,
          temperature: 0.3,
          prompt: buildPrompt(event, ctx),
          abortSignal: ac.signal,
        })
        const trimmed = text.trim()
        if (trimmed.length === 0) return null
        lastFinishedAt = Date.now()
        return trimmed
      } catch (err) {
        if (logger) {
          await logger.warn("narrator summary failed", {
            error: err,
            operation: "summarizing event for narration",
            input: {
              eventType: event.type,
              assistantTextLen: ctx.assistantText.length,
              recentToolsCount: ctx.recentTools.length,
            },
          })
        }
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
```

- [ ] **Step 4: Pass `narratorLog` in `src/index.ts`**

Edit `src/index.ts`. Update line 160:

```ts
  const narrator = createNarrator(languageModel, config.narrator, narratorLog)
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/handlers/narrator.ts src/index.ts test/handlers-narrator.test.ts
git commit -m "log: inject child logger into Narrator and upgrade silent catch"
```

---

## Task 12: Final verification and acceptance criteria

**Files:** none modified unless verification surfaces issues.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass — the new tests added in Tasks 3, 4, 5, 6, 9, 10, 11 plus all pre-existing tests.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 3: Run the production build**

Run: `npm run build`
Expected: `Build success` from tsup, no errors. `dist/index.js` exists.

- [ ] **Step 4: Verify the inline source map is present**

Run: `grep -c "sourceMappingURL=data:application/json;base64" dist/index.js`
Expected: `1`.

- [ ] **Step 5: Verify no `String(err)` calls remain in `src/`**

Run: `rg "String\(err\)" src/`
Expected: no matches.

- [ ] **Step 6: Verify silent `catch { }` count is at most one**

Run: `rg "catch \{\s*\}" src/`
Expected: at most one match. Specifically, `src/audio/runner.ts:34` may match — that's the **intentional** PATH-iteration continuation and is NOT in scope for this work (it has a `/* keep searching */` comment marking intent). If `src/log.ts` no longer contains a literal `catch { }` (because we widened it during Task 5), that's fine. Confirm the only remaining match (if any) is the runner.ts one and that it has a comment explaining the intent.

- [ ] **Step 7: Verify all log call sites in `src/index.ts` go through a child logger**

Run: `rg "\b(await|void) logger\." src/index.ts`
Expected: zero matches. All calls should use `initLog`, `dispatchLog`, `queueLog`, `narratorLog`, `audioLog`, or `ttsLog`. If there are stragglers, decide which module owns them.

- [ ] **Step 8: Manual smoke test — induce a real error**

Trigger a known error path and inspect the resulting log file.

Steps:
1. Edit `~/.config/opencode/opencode.json` (or wherever opencode reads config) and configure the plugin with an intentionally invalid model slug, e.g. `"narrator": { "model": "definitely-not-a-real-model" }`.
2. Start opencode normally.
3. In another terminal: `bash scripts/logs.sh`.

Expected: a log entry appears with structure like:

```jsonc
{
  "service": "opencode-speaker",
  "level": "error",
  "message": "Invalid model slug; plugin disabled",
  "extra": {
    "bindings": { "module": "init" },
    "operation": "resolving model slugs",
    "input": { "narrator": "definitely-not-a-real-model", "tts": "..." },
    "error": {
      "name": "ConfigError",
      "message": "...",
      "stack": "ConfigError: ...\n    at resolveLanguageModel (/abs/path/src/ai-sdk/models.ts:LINE:COL)\n    ...",
      "file": "/abs/path/src/ai-sdk/models.ts",
      "line": <number>,
      "function": "resolveLanguageModel"
    }
  }
}
```

Confirm:
- `error.file` ends in `.ts` (not `.js`) — confirming source maps work.
- `error.line` is a real line number > 0.
- `operation` and `input` are present.
- `bindings.module` is `"init"`.
- No `apiKey` / `token` / `secret` values appear in plain text anywhere.

Restore the config after this check.

- [ ] **Step 9: Commit any final fixes (if needed)**

If the smoke test surfaced any issues, fix them, run `npm test`, and commit:

```bash
git add -A
git commit -m "log: fixes from final smoke test"
```

Otherwise, no commit needed in this step.

- [ ] **Step 10: Final status check**

Run: `git status && git log --oneline -20`
Expected: clean working tree; commit log shows the per-task commits from Tasks 1–11 (and optionally Task 12 step 9).

---

## Self-Review Notes

After writing this plan, I checked it against the spec:

- **Spec §1 / §12 acceptance** (every error log contains `error.{name, message, stack, file, line, function}` + `operation` + `input`) — covered by Tasks 5 (auto-serialize), 6 (source maps E2E), 7–11 (call-site migration). The acceptance criterion `rg "String(err)" src/` is verified explicitly in Task 12 Step 5.
- **Spec §2 (Non-goals)** — Honored: no correlation IDs, no deeper cause walk (one level only — Task 3 Step 1 test 4), no new debug call sites, no latency/duration, no new destinations.
- **Spec §5 (Logger API)** — Types in Task 2, helper in Task 3, smart emit in Task 5, child in Task 5.
- **Spec §6 (source maps)** — Task 1.
- **Spec §7 (redaction, truncation, safety)** — Task 4 (cycle-safe redact + truncation). Existing `SENSITIVE_KEYS` preserved.
- **Spec §8 (subsystem injection)** — Tasks 9, 10, 11 cover the three subsystems with meaningful internal catches. The "File Structure / NOT modified" section above documents the divergence for audio runner/player and tts provider/ai-sdk — their errors are caught at the boundary in `index.ts` with `audioLog` and `ttsLog` (Tasks 7, 8) so all five logical modules still appear in `bindings.module`.
- **Spec §9 (call-site conventions)** — All Task 7–11 examples follow the `{ error, operation, input }` shape with short stable messages.
- **Spec §10 (testing strategy)** — 8 tests in Task 3, 6 tests in Task 4, 9 tests in Task 5, 1 E2E test in Task 6, 1 test each in Tasks 9, 10, 11. Total: 27 new test cases. Spec called for "15 new/updated tests"; this plan adds more (closer to ~27) because the spec's enumeration was a minimum.
- **Type consistency** — `Logger` interface defined in Task 2 is what Tasks 5, 9, 10, 11 all reference. `serializeError` signature (`(err: unknown) => SerializedError`) is consistent across Task 3 implementation and Task 6 E2E test. `SpeechQueueOptions.logger` and `DispatcherOptions.logger` are both `Logger` (optional).
- **Placeholder scan** — none. All code blocks are complete. All commands are real.
- **Frequent commits** — 11 commits across the 12 tasks (Task 12 only commits if smoke test surfaces issues). Each commit is self-contained and the working tree is green after each.
