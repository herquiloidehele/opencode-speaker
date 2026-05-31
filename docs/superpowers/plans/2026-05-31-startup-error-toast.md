# Startup Error Toast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace silent plugin self-disable with a user-visible TUI toast for every init-time misconfiguration (schema, slug, missing API key, TTS init failure, catch-all), while preserving today's structured logging.

**Architecture:** Two new pure-ish modules — `src/notify.ts` (toast + log wrapper, duck-types `client.tui.showToast`) and `src/ai-sdk/credentials.ts` (provider → env-var lookup). Targeted edits in `src/index.ts` insert a new credentials check between slug resolution and TTS init, and replace every `await logger.error(...) + return {}` site with `notifier.fatal(...) + return {}`. The outer catch is upgraded to also notify.

**Tech Stack:** TypeScript (ESM), `tsup`, `vitest`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-31-startup-error-toast-design.md`

---

## File Structure

### Files created

- `src/notify.ts` — `createNotifier(client, logger)` factory. Exposes `fatal(summary, detail?)` and `warn(summary, detail?)`. Always logs via `logger.error` / `logger.warn`. Best-effort `client.tui.showToast`. Truncates toast body to 200 chars. Fire-and-forget.
- `src/ai-sdk/credentials.ts` — Pure module. Exports `requiredEnvVar(slug)` and `checkCredentials({ narratorSlug, ttsSlug }, env)`. Knows the `openai/anthropic/elevenlabs` → env-var mapping.
- `test/notify.test.ts` — Unit tests for the notifier: toast shape, logger forwarding, truncation, graceful degradation when `client.tui` is missing or `showToast` throws/rejects.
- `test/credentials.test.ts` — Table-driven tests for `requiredEnvVar` and `checkCredentials`: each provider, mixed providers, de-duplication, empty / whitespace env values, unknown providers, malformed slugs.

### Files modified

- `src/index.ts` — Import `createNotifier` and `checkCredentials`. Build notifier after logger in both the outer catch and inside `initPlugin`. Insert new credentials check between slug resolution and `aiSdkProvider.init`. Replace the four `logger.error(...) ; return {}` sites with `notifier.fatal(...) ; return {}`. Add private helpers `formatSchemaErrors` and `oneLine`.
- `test/index.test.ts` — Stub `OPENAI_API_KEY` in `beforeEach` so existing happy-path tests don't trip the new credentials check. Add new integration tests for each toast-triggering branch.
- `README.md` — Update the "Plugin self-disables silently" troubleshooting line to mention the new toast behavior.

### Files NOT modified

- `src/log.ts` — Logger API is already rich enough (`logger.error(msg, ctx)` auto-serializes Errors, supports `child(...)`). No changes needed.
- `src/dispatcher.ts`, `src/queue/speech-queue.ts`, `src/handlers/narrator.ts`, `src/audio/*`, `src/tts/*`, `src/commands/*`, `src/api.ts` — Untouched. Runtime errors continue to flow through existing `onError` callbacks.
- `src/config.ts` — Schema is unchanged. We only consume `parsed.errors` (already exposed via `ParseResult`).
- `src/ai-sdk/models.ts` — `ConfigError` and the slug resolvers are unchanged. `credentials.ts` does its own prefix lookup and intentionally duplicates the provider list (see spec §6.4).

---

## Coding Conventions

- **No comments unless they explain non-obvious "why".** Match the existing code style — sparse comments where intent isn't clear from code. Don't add JSDoc to every function. Don't restate what the code does.
- **No emojis** in code, tests, commit messages, or documentation.
- **Match existing formatting** — 2-space indent, double quotes for strings. Check whether the file uses semicolons (most do); match.
- **Import style** — use `.js` extensions on relative imports (project is ESM): `import { x } from "./y.js"`.
- **TypeScript strictness** — match what the codebase already does. Don't add `any` casts beyond what's already there. Use `Pick<Logger, ...>` style narrow interfaces when only a subset is needed.

---

## Task 1: Credentials module (pure, TDD)

**Files:**
- Create: `test/credentials.test.ts`
- Create: `src/ai-sdk/credentials.ts`

- [ ] **Step 1: Write the failing test file**

Create `test/credentials.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { requiredEnvVar, checkCredentials } from "../src/ai-sdk/credentials.js"

describe("requiredEnvVar", () => {
  it.each([
    ["openai/gpt-4.1-mini", "OPENAI_API_KEY"],
    ["openai/gpt-4o-mini-tts", "OPENAI_API_KEY"],
    ["anthropic/claude-haiku-4", "ANTHROPIC_API_KEY"],
    ["elevenlabs/eleven_turbo_v2_5", "ELEVENLABS_API_KEY"],
  ])("maps %s to %s", (slug, env) => {
    expect(requiredEnvVar(slug)).toBe(env)
  })

  it.each([
    ["foo/bar"],
    ["openai"],
    [""],
    ["/no-prefix"],
  ])("returns null for unmapped or malformed slug %s", (slug) => {
    expect(requiredEnvVar(slug)).toBeNull()
  })
})

describe("checkCredentials", () => {
  it("ok when both providers' env vars are present", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        { OPENAI_API_KEY: "k" },
      ),
    ).toEqual({ ok: true })
  })

  it("de-duplicates when narrator and tts share a provider", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        {},
      ),
    ).toEqual({ ok: false, missing: ["OPENAI_API_KEY"] })
  })

  it("reports both missing keys when providers differ", () => {
    expect(
      checkCredentials(
        { narratorSlug: "anthropic/a", ttsSlug: "elevenlabs/b" },
        {},
      ),
    ).toEqual({ ok: false, missing: ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"] })
  })

  it("treats empty string as missing", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        { OPENAI_API_KEY: "" },
      ),
    ).toEqual({ ok: false, missing: ["OPENAI_API_KEY"] })
  })

  it("treats whitespace-only as missing", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        { OPENAI_API_KEY: "   " },
      ),
    ).toEqual({ ok: false, missing: ["OPENAI_API_KEY"] })
  })

  it("ignores unknown providers (slug resolver catches them separately)", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "foo/bar" },
        { OPENAI_API_KEY: "k" },
      ),
    ).toEqual({ ok: true })
  })

  it("missing array is sorted", () => {
    const result = checkCredentials(
      { narratorSlug: "elevenlabs/x", ttsSlug: "anthropic/y" },
      {},
    )
    expect(result).toEqual({
      ok: false,
      missing: ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"],
    })
  })
})
```

- [ ] **Step 2: Run the new test file to confirm it fails**

Run: `npx vitest run test/credentials.test.ts`

Expected: FAIL with a module-not-found / "Cannot find module '../src/ai-sdk/credentials.js'" style error. This proves the harness is wired correctly.

- [ ] **Step 3: Create the credentials module**

Create `src/ai-sdk/credentials.ts`:

```ts
const ENV_VAR_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
}

export function requiredEnvVar(slug: string): string | null {
  const slash = slug.indexOf("/")
  if (slash <= 0) return null
  const provider = slug.slice(0, slash)
  return ENV_VAR_BY_PROVIDER[provider] ?? null
}

export interface CredentialCheck {
  narratorSlug: string
  ttsSlug: string
}

export type CredentialResult =
  | { ok: true }
  | { ok: false; missing: string[] }

export function checkCredentials(
  check: CredentialCheck,
  env: Record<string, string | undefined>,
): CredentialResult {
  const required = new Set<string>()
  for (const slug of [check.narratorSlug, check.ttsSlug]) {
    const v = requiredEnvVar(slug)
    if (v) required.add(v)
  }
  const missing: string[] = []
  for (const name of required) {
    const val = env[name]
    if (val === undefined || val.trim().length === 0) missing.push(name)
  }
  missing.sort()
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `npx vitest run test/credentials.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ai-sdk/credentials.ts test/credentials.test.ts
git commit -m "feat(credentials): add provider-to-env-var check"
```

---

## Task 2: Notify module (TDD)

**Files:**
- Create: `test/notify.test.ts`
- Create: `src/notify.ts`

- [ ] **Step 1: Write the failing test file**

Create `test/notify.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest"
import { createNotifier } from "../src/notify.js"

function makeLogger() {
  return {
    error: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  }
}

describe("createNotifier.fatal", () => {
  it("calls showToast once with error variant and prefixed message", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    notifier.fatal("invalid config — tts.model bad")

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith({
      body: {
        message: "opencode-speaker: invalid config — tts.model bad",
        variant: "error",
      },
    })
  })

  it("also calls logger.error with summary and detail", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)
    const detail = { errors: [{ path: "tts.model", message: "bad" }] }

    notifier.fatal("invalid config", detail)

    expect(logger.error).toHaveBeenCalledWith("invalid config", detail)
  })

  it("returns synchronously; does not await showToast", () => {
    let resolved = false
    const showToast = vi
      .fn()
      .mockReturnValue(new Promise((r) => setTimeout(() => { resolved = true; r(true) }, 50)))
    const notifier = createNotifier({ tui: { showToast } }, makeLogger())

    notifier.fatal("hi")
    expect(resolved).toBe(false)
  })

  it("does not throw when showToast rejects; logs debug", async () => {
    const showToast = vi.fn().mockRejectedValue(new Error("boom"))
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    await new Promise((r) => setImmediate(r))
    expect(logger.debug).toHaveBeenCalledWith(
      "toast surface failed",
      expect.objectContaining({ error: expect.any(Error) }),
    )
  })

  it("does not throw when showToast throws synchronously; logs debug", () => {
    const showToast = vi.fn().mockImplementation(() => {
      throw new Error("sync boom")
    })
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    expect(logger.debug).toHaveBeenCalledWith(
      "toast surface failed",
      expect.objectContaining({ error: expect.any(Error) }),
    )
  })

  it("does not throw and does not log debug when client.tui is missing", () => {
    const logger = makeLogger()
    const notifier = createNotifier({}, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    expect(logger.error).toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it("does not throw and does not log debug when client is undefined", () => {
    const logger = makeLogger()
    const notifier = createNotifier(undefined, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    expect(logger.error).toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it("truncates the toast body to exactly 200 chars with ellipsis", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const notifier = createNotifier({ tui: { showToast } }, makeLogger())
    const longSummary = "x".repeat(500)

    notifier.fatal(longSummary)

    const call = showToast.mock.calls[0][0] as { body: { message: string } }
    expect(call.body.message.length).toBe(200)
    expect(call.body.message.endsWith("…")).toBe(true)
  })

  it("does not truncate or alter the summary passed to logger.error", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)
    const longSummary = "y".repeat(500)

    notifier.fatal(longSummary)

    expect(logger.error).toHaveBeenCalledWith(longSummary, undefined)
  })
})

describe("createNotifier.warn", () => {
  it("uses warning variant and logger.warn", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    notifier.warn("audio player missing")

    expect(showToast).toHaveBeenCalledWith({
      body: {
        message: "opencode-speaker: audio player missing",
        variant: "warning",
      },
    })
    expect(logger.warn).toHaveBeenCalledWith("audio player missing", undefined)
    expect(logger.error).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the new test file to confirm it fails**

Run: `npx vitest run test/notify.test.ts`

Expected: FAIL with "Cannot find module '../src/notify.js'".

- [ ] **Step 3: Create the notify module**

Create `src/notify.ts`:

```ts
import type { Logger } from "./log.js"

const TOAST_MAX_LEN = 200
const TOAST_PREFIX = "opencode-speaker: "

export type ToastVariant = "error" | "warning" | "info" | "success"

export interface NotifierClient {
  tui?: {
    showToast?: (req: {
      body: { message: string; variant: ToastVariant }
    }) => Promise<unknown>
  }
}

export interface Notifier {
  fatal(summary: string, detail?: unknown): void
  warn(summary: string, detail?: unknown): void
}

type NotifyLogger = Pick<Logger, "error" | "warn" | "debug">

function buildMessage(summary: string): string {
  const raw = TOAST_PREFIX + summary
  if (raw.length <= TOAST_MAX_LEN) return raw
  return raw.slice(0, TOAST_MAX_LEN - 1) + "…"
}

function tryShowToast(
  client: NotifierClient | undefined,
  message: string,
  variant: ToastVariant,
  logger: NotifyLogger,
): void {
  const showToast = client?.tui?.showToast
  if (typeof showToast !== "function") return
  try {
    const result = showToast({ body: { message, variant } })
    if (result && typeof (result as Promise<unknown>).then === "function") {
      ;(result as Promise<unknown>).catch((error) => {
        void logger.debug("toast surface failed", { error })
      })
    }
  } catch (error) {
    void logger.debug("toast surface failed", { error })
  }
}

export function createNotifier(
  client: NotifierClient | undefined,
  logger: NotifyLogger,
): Notifier {
  return {
    fatal(summary, detail) {
      void logger.error(summary, detail)
      tryShowToast(client, buildMessage(summary), "error", logger)
    },
    warn(summary, detail) {
      void logger.warn(summary, detail)
      tryShowToast(client, buildMessage(summary), "warning", logger)
    },
  }
}
```

- [ ] **Step 4: Run the notify test file to confirm it passes**

Run: `npx vitest run test/notify.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/notify.ts test/notify.test.ts
git commit -m "feat(notify): add TUI toast notifier with log fallback"
```

---

## Task 3: Make existing index tests resilient to credentials check

**Background:** `test/index.test.ts` currently calls `OpencodeSpeaker(baseCtx(), ...)` without setting `OPENAI_API_KEY`. After Task 4 wires the credentials check in, every one of those success-path tests would start failing because the plugin would disable itself at the new check. We stub the env up-front so the existing tests stay green when Task 4 lands.

**Files:**
- Modify: `test/index.test.ts`

- [ ] **Step 1: Add `beforeEach` / `afterEach` env stubs**

Open `test/index.test.ts`. Change the imports line and the `describe("OpencodeSpeaker plugin", ...)` setup as shown.

Before (line 1):
```ts
import { describe, it, expect, vi } from "vitest"
```

After:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
```

Inside `describe("OpencodeSpeaker plugin", ...)`, after `const baseCtx = ...` and before the first `it(...)` (around line 33), insert:

```ts
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-for-init")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })
```

- [ ] **Step 2: Run the test file to confirm still green**

Run: `npx vitest run test/index.test.ts`

Expected: all existing tests still pass. (The stub is a no-op for current behavior — it just preempts future breakage.)

- [ ] **Step 3: Commit**

```bash
git add test/index.test.ts
git commit -m "test(index): stub OPENAI_API_KEY for happy-path tests"
```

---

## Task 4: Wire notifier and credentials check into `src/index.ts` (TDD)

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

This task is the integration. We write the new failing tests first, watch them fail, then make the change to `src/index.ts` that makes all of them pass at once.

- [ ] **Step 1: Add the new failing integration tests**

Open `test/index.test.ts`. After the last existing `it(...)` in `describe("OpencodeSpeaker plugin", ...)` (i.e., after the `"falls back to defaults when options is undefined"` test), append a new `describe` block that captures the toast spy through `baseCtx`.

First, modify `baseCtx()` to also expose a `tui.showToast` spy. Replace the existing `baseCtx` factory:

```ts
  const baseCtx = () =>
    ({
      client: { app: { log: vi.fn().mockResolvedValue(undefined) } },
      directory: "/tmp",
      worktree: "/tmp",
      project: { id: "test" },
      $: vi.fn(),
    }) as any
```

with:

```ts
  const baseCtx = () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const ctx = {
      client: {
        app: { log: vi.fn().mockResolvedValue(undefined) },
        tui: { showToast },
      },
      directory: "/tmp",
      worktree: "/tmp",
      project: { id: "test" },
      $: vi.fn(),
    } as any
    return { ctx, showToast }
  }
```

Then update each existing test that calls `OpencodeSpeaker(baseCtx(), ...)` to destructure: `const { ctx } = baseCtx()` and pass `ctx`. There are five call sites in the existing file to update (all five `it(...)` blocks inside `describe("OpencodeSpeaker plugin")`).

For example, the `"registers an event hook..."` test becomes:

```ts
  it("registers an `event` hook that does not throw on unknown events", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { events: {} })) as any
    expect(typeof hooks.event).toBe("function")
    await expect(
      hooks.event({ event: { type: "some.unknown.event" } }),
    ).resolves.toBeUndefined()
  })
```

Apply the same destructure-then-pass pattern to all four existing tests in this `describe` block.

Then append the new integration describe block at the end of the file:

```ts
describe("OpencodeSpeaker init-failure toasts", () => {
  const baseCtx = () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const ctx = {
      client: {
        app: { log: vi.fn().mockResolvedValue(undefined) },
        tui: { showToast },
      },
      directory: "/tmp",
      worktree: "/tmp",
      project: { id: "test" },
      $: vi.fn(),
    } as any
    return { ctx, showToast }
  }

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-for-init")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("toasts when the config has a schema error", async () => {
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      tts: { model: "not-a-slug" },
    })) as any
    expect(hooks).toEqual({})
    expect(showToast).toHaveBeenCalledTimes(1)
    const arg = showToast.mock.calls[0][0]
    expect(arg.body.variant).toBe("error")
    expect(arg.body.message).toMatch(/invalid config —/)
    expect(arg.body.message).toMatch(/tts\.model/)
  })

  it("toasts when OPENAI_API_KEY is missing", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("OPENAI_API_KEY", "")
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {})) as any
    expect(hooks).toEqual({})
    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.message).toMatch(
      /OPENAI_API_KEY not set/,
    )
  })

  it("toasts when both narrator and tts keys are missing", async () => {
    vi.unstubAllEnvs()
    vi.stubEnv("OPENAI_API_KEY", "")
    vi.stubEnv("ANTHROPIC_API_KEY", "")
    vi.stubEnv("ELEVENLABS_API_KEY", "")
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      narrator: { model: "anthropic/claude-haiku-4" },
      tts: { model: "elevenlabs/eleven_turbo_v2_5" },
    })) as any
    expect(hooks).toEqual({})
    expect(showToast).toHaveBeenCalledTimes(1)
    const msg = showToast.mock.calls[0][0].body.message
    expect(msg).toMatch(/ANTHROPIC_API_KEY/)
    expect(msg).toMatch(/ELEVENLABS_API_KEY/)
  })

  it("does NOT toast when enabled is false (intentional opt-out)", async () => {
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { enabled: false })) as any
    expect(hooks).toEqual({})
    expect(showToast).not.toHaveBeenCalled()
  })

  it("does NOT toast on the happy path", async () => {
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { startMuted: true })) as any
    expect(typeof hooks.event).toBe("function")
    expect(showToast).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test file to confirm new tests fail**

Run: `npx vitest run test/index.test.ts`

Expected: the five new tests in `"OpencodeSpeaker init-failure toasts"` all fail. The schema/missing-key tests will fail because `showToast` is never called by the current `src/index.ts`. The "does NOT toast on happy path" test should pass already (no toast is called today).

Existing tests should still pass.

- [ ] **Step 3: Modify `src/index.ts` — add imports**

Open `src/index.ts`. After the existing imports block (currently lines 1–18), add two new import lines:

```ts
import { createNotifier } from "./notify.js"
import { checkCredentials } from "./ai-sdk/credentials.js"
```

- [ ] **Step 4: Modify `src/index.ts` — upgrade the outer catch**

Find the outer catch in `OpencodeSpeaker` (lines 40–53). Replace the existing catch block:

```ts
  } catch (err) {
    // Last-line-of-defense: never let plugin failure crash opencode startup.
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
```

with:

```ts
  } catch (err) {
    // Last-line-of-defense: never let plugin failure crash opencode startup.
    try {
      const logger = createLogger(ctx.client as any, PLUGIN_NAME)
      const notifier = createNotifier(ctx.client as any, logger)
      notifier.fatal("failed to initialize; plugin disabled", { error: err })
    } catch {
      /* logger/notifier itself failed; nothing we can safely do */
    }
    return {}
  }
```

Two intentional changes:
- We pass the raw `err` (no `String(err)` wrapping) — the logger already auto-serializes Errors with structured fields. This is consistent with the enriched-logging spec.
- The toast surface gets a chance.

- [ ] **Step 5: Modify `src/index.ts` — build the notifier inside `initPlugin`**

Find this block (around lines 56–62):

```ts
async function initPlugin(ctx: PluginCtx, options?: PluginOptions) {
  const logger = createLogger(ctx.client as any, PLUGIN_NAME)
  // opencode passes per-plugin config as the second argument when the user
  // declares the plugin in tuple form: ["opencode-speaker", { ...options }].
  // We accept any user object and let parseConfig validate + apply defaults.
  const rawConfig = options ?? {}
  const parsed = parseConfig(rawConfig)
```

Add the notifier construction one line after `createLogger`:

```ts
async function initPlugin(ctx: PluginCtx, options?: PluginOptions) {
  const logger = createLogger(ctx.client as any, PLUGIN_NAME)
  const notifier = createNotifier(ctx.client as any, logger)
  // opencode passes per-plugin config as the second argument when the user
  // declares the plugin in tuple form: ["opencode-speaker", { ...options }].
  // We accept any user object and let parseConfig validate + apply defaults.
  const rawConfig = options ?? {}
  const parsed = parseConfig(rawConfig)
```

- [ ] **Step 6: Modify `src/index.ts` — add the two private helpers**

These helpers are used by Steps 7, 8, and 10. Add them now so the file stays in a coherent state.

Insert these two function declarations **between** the `type PluginOptions = ...` line (around line 37) and the `export const OpencodeSpeaker = ...` line (around line 39):

```ts
function formatSchemaErrors(errors: { path: string; message: string }[]): string {
  const parts = errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
  return `invalid config — ${parts.join("; ")}`
}

function oneLine(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err)
  return s.replace(/\s+/g, " ").trim()
}
```

(Function declarations are hoisted, so the position is functional rather than semantic — but placing them above the entrypoint keeps the file readable top-to-bottom.)

- [ ] **Step 7: Modify `src/index.ts` — replace site 1 (schema)**

Find (around line 64):

```ts
  if (!parsed.ok) {
    await logger.error("Invalid voice config; plugin disabled", { errors: parsed.errors })
    return {}
  }
```

Replace with:

```ts
  if (!parsed.ok) {
    notifier.fatal(formatSchemaErrors(parsed.errors), { errors: parsed.errors })
    return {}
  }
```

- [ ] **Step 8: Modify `src/index.ts` — replace site 2 (slug)**

Find (around lines 81–90):

```ts
  } catch (err) {
    if (err instanceof ConfigError) {
      await logger.error(`Invalid model slug; plugin disabled: ${err.message}`)
    } else {
      await logger.error("Failed to resolve models; plugin disabled", {
        error: String(err),
      })
    }
    return {}
  }
```

Replace with:

```ts
  } catch (err) {
    if (err instanceof ConfigError) {
      notifier.fatal(`invalid model slug — ${err.message}`, { error: err })
    } else {
      notifier.fatal(`failed to resolve models — ${oneLine(err)}`, { error: err })
    }
    return {}
  }
```

- [ ] **Step 9: Modify `src/index.ts` — add credentials check (NEW)**

Immediately after the slug-resolution `try/catch` (the one you just edited) and **before** `// 2. Register the AI SDK TTS provider.`, insert the new credentials gate.

The location: between the closing `}` of the slug `try/catch` (around line 90 after Step 8) and the comment `// 2. Register the AI SDK TTS provider.` (around line 92).

```ts
  const credCheck = checkCredentials(
    { narratorSlug: config.narrator.model, ttsSlug: config.tts.model },
    process.env,
  )
  if (!credCheck.ok) {
    notifier.fatal(
      `${credCheck.missing.join(", ")} not set; plugin disabled`,
      { missing: credCheck.missing },
    )
    return {}
  }

```

- [ ] **Step 10: Modify `src/index.ts` — replace site 3 (TTS init)**

Find (around lines 100–105 after the previous edits — the catch block right after `aiSdkProvider.init(...)`):

```ts
  } catch (err) {
    await logger.error("Failed to initialize TTS provider; plugin disabled", {
      error: String(err),
    })
    return {}
  }
```

Replace with:

```ts
  } catch (err) {
    notifier.fatal(`TTS init failed — ${oneLine(err)}`, { error: err })
    return {}
  }
```

- [ ] **Step 11: Modify `src/index.ts` — replace site 4 (provider not registered)**

Find (around lines 109–114):

```ts
  const provider = getProvider(resolvedSpeech.provider)
  if (!provider) {
    await logger.error(
      `TTS provider not found after registration: ${resolvedSpeech.provider}`,
    )
    return {}
  }
```

Replace with:

```ts
  const provider = getProvider(resolvedSpeech.provider)
  if (!provider) {
    notifier.fatal(
      `provider not found after registration: ${resolvedSpeech.provider}`,
    )
    return {}
  }
```

- [ ] **Step 12: Run the index test file to confirm everything passes**

Run: `npx vitest run test/index.test.ts`

Expected: all tests pass — both the existing five and the new five integration tests.

If a test fails because it gets a "missing key" toast instead of the schema toast you expected, double-check the ordering in `initPlugin`: schema check (Step 7) must run before credentials check (Step 9).

- [ ] **Step 13: Run the full test suite**

Run: `npm test`

Expected: every test in every file passes.

- [ ] **Step 14: Run the typechecker**

Run: `npm run typecheck`

Expected: no errors. If you see complaints about `ctx.client as any` not having `tui.showToast`, that's fine — the existing code uses `as any` for the same reason; the notifier uses its own narrow duck-typed interface internally.

- [ ] **Step 15: Run the build**

Run: `npm run build`

Expected: clean tsup build, `dist/index.js` produced.

- [ ] **Step 16: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat(index): toast on init-time misconfiguration"
```

---

## Task 5: Update README troubleshooting note

**Files:**
- Modify: `README.md:238` (the "Plugin self-disables silently" line)

- [ ] **Step 1: Update the troubleshooting paragraph**

Open `README.md`. Find the line (around line 238):

```
**Plugin self-disables silently:** check opencode's log file — `opencode-speaker` errors are logged at `error` / `warn` level.
```

Replace with:

```
**Plugin disabled with a toast on startup:** the toast carries a short summary (invalid config, missing API key, TTS init failure). The full structured detail is in opencode's log file — `opencode-speaker` errors are logged at `error` / `warn` level.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): mention startup toast for misconfig"
```

---

## Final Verification

- [ ] **Step 1: Full test suite**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: clean build.

- [ ] **Step 4: Manual smoke test against opencode (optional)**

If you have a local opencode install and want to verify visually:

```bash
rm -rf ~/.cache/opencode/node_modules/opencode-speaker && npm run build
unset OPENAI_API_KEY
opencode   # launch the TUI in another terminal
```

Expected: a red toast appears in the opencode TUI reading `opencode-speaker: OPENAI_API_KEY not set; plugin disabled`. Re-set the env var and relaunch — no toast.

- [ ] **Step 5: Review the git log**

Run: `git log --oneline -6`

Expected to see (in order, newest last):
1. `feat(credentials): add provider-to-env-var check`
2. `feat(notify): add TUI toast notifier with log fallback`
3. `test(index): stub OPENAI_API_KEY for happy-path tests`
4. `feat(index): toast on init-time misconfiguration`
5. `docs(readme): mention startup toast for misconfig`
