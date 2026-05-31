# Enriched Logging — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming)
**Scope:** `opencode-speaker` plugin (`src/log.ts` and every call site)

---

## 1. Goal

When an error occurs anywhere in `opencode-speaker`, the resulting log entry must contain enough information to debug it without re-running the failure: the error's identity (`name`/`code`/`message`), the precise source location (file/line/function — in TypeScript coordinates), the full stack, what the code was trying to do (operation), and the relevant input that triggered it (safely redacted).

Today, every error is logged as `String(err)`, which drops stack, name, code, file, and line. Subsystems (`dispatcher`, `queue`, `narrator`, `audio`, `tts`) report via `onError` callbacks routed to `src/index.ts`, so any subsystem-local context is lost by the time a log entry is emitted. Source maps are not loaded, so even if stacks were preserved they would point into `dist/index.js`.

## 2. Non-Goals

- Correlation IDs across events (possible follow-up).
- Walking and flattening `err.cause` beyond one level (we preserve one level; deeper chains are not flattened).
- Adding new `debug`-level call sites (separate concern; the level remains supported but unused).
- Latency / duration metrics.
- Changing log destination (still `client.app.log`).

## 3. Background — Current State

- **Logger module:** `src/log.ts` (55 lines). Thin wrapper around opencode's host `client.app.log`. No external logging library.
- **Levels supported:** `debug | info | warn | error`. `debug` has zero call sites.
- **Payload shape today:** `{ service: "opencode-speaker", level, message, extra? }` where `extra` runs through `redact()` to mask `apiKey/api_key/authorization/secret/token/password`.
- **Call sites:** 22 in `src/index.ts`. Zero in subsystems. Subsystems bubble errors up via `onError(err)`; `index.ts` logs them with `String(err)`.
- **Silent error swallowers:** `src/audio/runner.ts:34` (`catch { }`) and `src/handlers/narrator.ts:77` (`catch { return null }`) discard errors with no log.
- **Build:** `tsup` bundles to `dist/index.js`. No source maps emitted today.

## 4. Architectural Decisions (Locked)

1. **Focus:** errors-first.
2. **Fields captured per error:** stack, file/line/function, error name & code, operation context, input snapshot.
3. **Source maps:** `sourcemap: "inline"` in `tsup.config.ts` plus `source-map-support/register` installed as the first import in `src/index.ts`.
4. **Architecture:** child loggers (`logger.child({ module })`) injected into all subsystems — five logical modules (`dispatcher`, `queue`, `narrator`, `audio`, `tts`) spanning seven files (audio and tts each split into two). Subsystems log directly with full local context while preserving their existing `onError` callbacks for the host's reactive side-effects.
5. **Rollout:** full one-pass — logger core, source-map plumbing, every existing call site, every subsystem injection, plus upgrading the two silent `catch` blocks.
6. **API shape:** smart `logger.error(msg, ctx)` that auto-serializes any Error it finds in `ctx` (or any Error passed directly). Lowest call-site friction; impossible to forget serialization.

## 5. Logger API

### 5.1 Types

```ts
export interface SerializedError {
  name: string                // 'TypeError', 'ZodError', 'Error', ...
  message: string
  code?: string | number      // err.code if present
  stack?: string              // full stack, TS-resolved via source-map-support
  file?: string               // 'src/dispatcher.ts'
  line?: number               // 142
  column?: number             // 17
  function?: string           // 'handleEvent'
  cause?: SerializedError     // preserved opportunistically, ONE level deep
}

export interface LogContext {
  error?: unknown             // Error or anything; Errors auto-serialized
  operation?: string          // 'speaking sentence', 'initializing TTS provider'
  input?: unknown             // redacted automatically
  [key: string]: unknown      // free-form structured fields
}

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(msg: string, ctx?: LogContext | unknown): Promise<void>
  info (msg: string, ctx?: LogContext | unknown): Promise<void>
  warn (msg: string, ctx?: LogContext | unknown): Promise<void>
  error(msg: string, ctx?: LogContext | unknown): Promise<void>
  child(bindings: { module: string; [k: string]: unknown }): Logger
}
```

### 5.2 Emit semantics

Every `debug/info/warn/error` call performs the following steps inside the existing `try/catch` boundary so the logger never throws:

1. If `ctx` is an `Error` instance → wrap into `{ error: ctx }`.
2. If `ctx.error instanceof Error` → replace it with `serializeError(ctx.error)`.
3. Apply `redact()` to the entire `ctx` object (including `input`).
4. Apply truncation (Section 7.2) to string fields, **except** `error.stack`.
5. Merge child bindings under a top-level `bindings` field (e.g. `bindings: { module: "queue" }`). Child-of-child concatenates bindings.
6. Forward to `client.app.log({ body: { service, level, message, extra } })`.
7. On any internal failure during steps 1–6, swallow and return — the logger must never throw or propagate.

### 5.3 `serializeError(err)` helper (exported)

- Reads `name`, `message`, `code`, `stack` from the Error.
- Parses the first non-internal frame from `stack` to populate `{ file, line, column, function }`. The stack is already source-map-resolved when `source-map-support` is installed (Section 6).
- If `err.cause instanceof Error`, recurses **exactly one level**.
- Handles non-Error throws (`throw "oops"`, `throw 42`, `throw { code: "X" }`) by returning `{ name: "NonError", message: String(value) }`. Never throws.
- The "first non-internal frame" rule: skip frames whose file is inside `node:`, `internal/`, or the logger module itself, then take the first remaining frame. If none remain, omit `file`/`line`/`function` rather than emit garbage.

### 5.4 Example payload

Call site:

```ts
catch (err) {
  await logger.error("speak failed", {
    error: err,
    operation: "speaking queued sentence",
    input: { voiceId, textPreview: text.slice(0, 80) },
  })
}
```

Forwarded payload:

```jsonc
{
  "service": "opencode-speaker",
  "level": "error",
  "message": "speak failed",
  "extra": {
    "bindings": { "module": "queue" },
    "operation": "speaking queued sentence",
    "input": { "voiceId": "alloy", "textPreview": "Hello, world." },
    "error": {
      "name": "TypeError",
      "message": "Cannot read properties of undefined (reading 'play')",
      "stack": "TypeError: ...\n    at SpeechQueue.flush (src/queue/speech-queue.ts:87:18)\n    ...",
      "file": "src/queue/speech-queue.ts",
      "line": 87,
      "column": 18,
      "function": "SpeechQueue.flush"
    }
  }
}
```

## 6. Source Maps & Runtime Hook

### 6.1 Build change — `tsup.config.ts`

Add `sourcemap: "inline"`. The map is embedded in `dist/index.js`. Bundle size grows by an estimated 30–50%; there is no separate `.map` file to coordinate when distributing the plugin.

### 6.2 Runtime hook — `src/index.ts`

Install `source-map-support` as the **very first import** so any error thrown after module load has a TS-resolved `stack`:

```ts
import "source-map-support/register"
// ... rest of imports
```

`source-map-support` patches `Error.prepareStackTrace`. There is no per-call overhead unless an error is actually thrown.

### 6.3 Dependency

Add to `package.json` **`dependencies`** (not `devDependencies`) — the plugin runs in the host's Node process at runtime:

```jsonc
"source-map-support": "^0.5.21",
"@types/source-map-support": "^0.5.10"   // devDependency
```

### 6.4 Caveat

Frames pointing into Node internals (`node:fs`, `node:http2`, etc.) are not rewritten — only frames that map back to bundled code. Expected and acceptable.

## 7. Redaction, Truncation, and Safety

### 7.1 Redaction (preserved)

`redact()` continues to recursively mask `apiKey/api_key/apikey/authorization/Authorization/secret/token/password`. It now runs over the entire `ctx` object, including `input` and any free-form fields. No call site needs to think about redaction.

### 7.2 Truncation

Add `MAX_FIELD_BYTES = 4096`. After redaction, walk the payload; any string field whose UTF-8 byte length exceeds the cap is replaced with `<original sliced>…<truncated:N bytes>` where `N` is the dropped byte count.

**Exemption:** `error.stack` is never truncated — full stacks are the entire point of this work.

This addresses the current problem at `src/index.ts:243-246` where the whole raw `command.executed` event is logged.

### 7.3 Circular references

`redact()` is extended to thread a `WeakSet` of visited objects. A cyclic reference becomes the string `"[Circular]"` rather than infinite-looping.

### 7.4 Non-Error throws

`serializeError` returns `{ name: "NonError", message: <best-effort string> }` for primitives, plain objects, etc. JSON-stringify is wrapped in `try/catch`; on failure, `message` falls back to `Object.prototype.toString.call(value)`.

### 7.5 Logger never throws (preserved guarantee)

The existing outer `try/catch` in `emit()` is widened to encompass the new serialization, redaction, and truncation steps. A getter that throws, an unserializable value, or a host failure all result in a swallowed error and a no-op return. This is non-negotiable.

## 8. Subsystem Injection

### 8.1 Child loggers created in `src/index.ts`

```ts
const root = createLogger(client, "opencode-speaker")
const initLog      = root.child({ module: "init" })
const dispatchLog  = root.child({ module: "dispatcher" })
const queueLog     = root.child({ module: "queue" })
const narratorLog  = root.child({ module: "narrator" })
const audioLog     = root.child({ module: "audio" })
const ttsLog       = root.child({ module: "tts" })
```

### 8.2 Injection points

| Subsystem | File | Change |
|---|---|---|
| Dispatcher | `src/dispatcher.ts` | Add `logger: Logger` to constructor/factory options; keep existing `onError` callback. |
| SpeechQueue | `src/queue/speech-queue.ts` | Same: add `logger`, keep `onError`. |
| Narrator | `src/handlers/narrator.ts` | Accept `logger` param. |
| Audio runner | `src/audio/runner.ts` | Accept `logger` param. |
| Audio player | `src/audio/player.ts` | Accept `logger` param. |
| TTS provider | `src/tts/provider.ts` | Accept `logger` param. |
| TTS ai-sdk | `src/tts/ai-sdk.ts` | Accept `logger` param. |

### 8.3 Two-channel pattern

Subsystems get the logger AND keep `onError`. The logger handles structured observability; `onError` preserves its existing semantics for the host (`index.ts`) to react to errors (disable a feature, fire a notification, etc.). This matches the "inject logger into subsystems" decision without removing the boundary `index.ts` relies on today.

### 8.4 Silent `catch` blocks (upgraded)

- `src/audio/runner.ts:34` (`catch { }`) → `await logger.warn("audio runner: <op> failed (continuing)", { error: err, operation, input })`
- `src/handlers/narrator.ts:77` (`catch { return null }`) → emit a `logger.warn` with `error`, `operation: "resolving narrator template"`, `input: { templateName, eventType }`, then `return null` as before.

`src/log.ts:45` (logger's own internal `catch { }`) **stays silent** — the logger must never throw.

## 9. Call-Site Conventions

All error logging follows one shape so logs are consistent and greppable.

```ts
await logger.error(<short stable message>, {
  error: err,                  // raw Error — logger auto-serializes
  operation: <verb-phrase>,    // present-progressive
  input: <local snapshot>,     // small object, redacted automatically
})
```

- **`message`** — short, stable, no interpolation. Variable bits go in `input`/`operation`. Bad: `"failed to speak voice alloy"`. Good: `"speak failed"` + `input: { voiceId: "alloy" }`.
- **`operation`** — present-progressive verb phrase describing what was in flight: `"initializing TTS provider"`, `"speaking queued sentence"`, `"resolving narrator template"`, `"dispatching opencode event"`, `"handling command shortcut"`.
- **`input`** — smallest local state that would let a human reproduce/understand the failure. Examples:
  - Queue: `{ voiceId, textPreview: text.slice(0, 80), queueDepth }`
  - Dispatcher: `{ eventType: event.type, partId }`
  - Narrator: `{ templateName, eventType }`
  - TTS: `{ providerName, modelSlug, requestSizeBytes }`

**Do not** put the raw event payload, raw error object, or large blobs in `input`. We want a snapshot, not a dump. Truncation (Section 7.2) is a safety net, not the strategy.

## 10. Testing Strategy

### 10.1 Extensions to `test/log.test.ts`

1. `serializeError(Error)` returns `{ name, message, stack, file, line, column, function }` for a normal Error.
2. `serializeError(err)` extracts the top non-internal stack frame (uses a fixture stack string).
3. `serializeError(err)` includes `code` when present.
4. `serializeError(err)` recurses ONE level into `cause`, not deeper.
5. `serializeError("string")` returns `{ name: "NonError", message: "string" }`.
6. `serializeError({ a: 1 })` returns `{ name: "NonError", message: '{"a":1}' }`.
7. `logger.error("msg", new Error("boom"))` produces an `extra.error` shape with serialized fields.
8. `logger.error("msg", { error: new Error("boom"), operation: "x", input: { apiKey: "secret" } })` — `input` is redacted, `error` is serialized, `operation` flows through.
9. `logger.child({ module: "queue" }).error("msg", {})` — payload includes `bindings.module === "queue"`.
10. Child-of-child concatenates bindings.
11. Truncation: a 10kB string in `input.foo` is truncated to `MAX_FIELD_BYTES + "…<truncated:N bytes>"`; an Error stack is NOT truncated.
12. Circular `input` does not infinite-loop; cycle becomes `"[Circular]"`.
13. Logger still does not throw when `client.app.log` throws.
14. Logger still does not throw when serialization itself throws (induced via a getter that throws).

### 10.2 New file `test/log.source-maps.test.ts`

15. End-to-end with `source-map-support/register` loaded — throw an Error from a function defined in a known TS source line, assert `serializeError`'s extracted `file` and `line` match `src/...` coordinates (not `dist/...`). Vitest runs the TS source directly so the resolver is genuinely exercised.

### 10.3 Subsystem tests

Existing subsystem tests are updated to pass a mock logger and assert it was called with the expected `module` binding, `operation`, and `input` shape. No new test files for subsystems; existing files grow.

## 11. Migration Order

Each step keeps the working tree green so reviewers can stop at any point.

1. **Tooling** — add `sourcemap: "inline"` to `tsup.config.ts`; add `source-map-support` (dep) and `@types/source-map-support` (devDep) to `package.json`; register the hook at the top of `src/index.ts`. Verify `tsup` build succeeds and a deliberately-thrown error in `tsx src/index.ts` produces `src/`-coordinate stacks.
2. **Logger core** — extend `src/log.ts` with `serializeError`, `LogContext`, smart emit (auto-serialize Errors, redact, truncate, circular-safe), and `.child()`. Update `test/log.test.ts` per Section 10.1. Add `test/log.source-maps.test.ts`. All existing call sites continue to compile because the new signature is a superset of the old one (`LogContext | unknown`).
3. **`index.ts` call sites** — update all 22 existing calls to use the new convention (`{ error, operation, input }`). Replace every `String(err)` with `err`. Add `initLog = root.child({ module: "init" })` for boot-path errors.
4. **Subsystem injection** — thread child loggers into `Dispatcher`, `SpeechQueue`, `Narrator`, `audio/runner`, `audio/player`, `tts/provider`, `tts/ai-sdk`. Wherever a subsystem currently fires `onError`, ALSO call `logger.error/warn` with full local context. `onError` semantics preserved.
5. **Silent catch upgrades** — `src/audio/runner.ts:34` and `src/handlers/narrator.ts:77` become `logger.warn(...)` calls with operation context.
6. **Verification** — `vitest run` green; `tsup` build green; manual smoke test: trigger a known error path (e.g. invalid TTS provider in config) and inspect `$OPENCODE_LOG_DIR/*.log` via `scripts/logs.sh`. Confirm stack resolves to `src/*.ts:N`, `operation` and `input` are present, secrets are masked.

## 12. Acceptance Criteria

The work is complete when **all** of the following hold:

- Every error log entry contains `error.{name, message, stack, file, line, function}` (where the underlying error supplied those properties), `operation`, and `input` (where applicable).
- `error.file` and `error.line` resolve to `src/*.ts` coordinates, not `dist/index.js`, in at least one end-to-end test and one manual smoke test.
- Every log entry carries a `bindings.module` field identifying the subsystem (`init | dispatcher | queue | narrator | audio | tts`).
- `apiKey/api_key/apikey/authorization/Authorization/secret/token/password` fields are masked anywhere in the payload (existing behavior preserved end-to-end).
- `rg "String\(err\)" src/` returns zero matches.
- `rg "catch \{\s*\}" src/` returns at most one match (the logger's own internal `catch { }` in `src/log.ts`).
- `vitest run` passes including the 15 new/updated tests in Section 10.
- `tsup` build produces `dist/index.js` containing an inline source map.
- The logger does not throw under any tested condition (host failure, getter that throws, circular input, non-Error throws).

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `source-map-support` adds runtime cost to every thrown Error | Acceptable — errors are rare; the overhead is only on `err.stack` access |
| Inline source maps bloat the bundle | Confirmed acceptable by user; alternative external `.map` file rejected during brainstorm |
| Smart `logger.error` "magic" makes behavior less obvious | Documented in Section 5.2; tests cover both `(msg, Error)` and `(msg, { error: Error })` forms |
| Subsystem migration is large surface | Phased rollout in Section 11 keeps each step independently shippable |
| Truncation could hide important data | `error.stack` exempted; cap is 4kB per string field (generous); truncation marker preserves byte count for debugging |
| `WeakSet`-based cycle detection has subtle correctness bugs | Covered by test 12; failure mode is `"[Circular]"` not a crash |
