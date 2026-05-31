# Startup Error Toast — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming)
**Scope:** `opencode-speaker` plugin — surface plugin-init misconfigurations as user-visible TUI toasts instead of disabling silently.

---

## 1. Goal

When the user starts opencode with `opencode-speaker` misconfigured, the user must see a clear, in-app error message explaining what is wrong, instead of the current "plugin self-disables silently" behavior. Four categories of misconfiguration must trigger a toast:

1. **Schema-invalid config** — fails the Zod parser in `parseConfig`.
2. **Invalid `provider/model` slug** — `resolveLanguageModel` / `resolveSpeechModel` throws `ConfigError`.
3. **Missing API key** for the configured provider(s) — detected proactively by checking env vars before any AI SDK call.
4. **TTS provider init failure** — `aiSdkProvider.init(...)` throws.

In all four cases the plugin still disables itself (`return {}`) as today — the change is that disabling is now *announced* rather than silent.

## 2. Non-Goals

- Audio-player-missing remains a `logger.warn` only. The plugin still partially functions in setups where cloud TTS is not used or where playback is handled elsewhere; warning the user there would be noise.
- Runtime errors during ordinary speech (queue/dispatcher/narrator failures) remain `logger.warn` via the existing `onError` callbacks. We are not introducing a "toast on every operational hiccup" policy.
- We do not network-probe the API key to validate its *value*. We only verify a key is *present* in the environment. An invalid-but-present key still surfaces — it falls through to the TTS-init-failure case, which already toasts.
- No OS-level notification fallback (`osascript`, `notify-send`, `New-BurntToastNotification`). If `client.tui.showToast` is not available on an older opencode version, we degrade silently to log-only — identical to today's behavior. No regression, no new shell branching.
- No new persistence — we do not write to a file or remember past errors across restarts. Each startup is independent.
- No changes to the `enabled === false` opt-out path (env or config). That is an explicit user decision, not a misconfiguration; it stays a `logger.info` line.
- No changes to dispatcher, queue, narrator, audio player, commands, the `voice` tool, or any event handler.

## 3. Background — Current State

`src/index.ts` (the plugin entrypoint) contains five distinct init-failure paths today. All of them follow the same pattern: `await logger.error(...)` then `return {}`.

| # | Location | Trigger |
|---|---|---|
| 1 | `initPlugin` after `parseConfig` (line ~64) | Zod schema validation fails on the user's config. |
| 2 | `initPlugin` after `resolveLanguageModel`/`resolveSpeechModel` (line ~81) | `ConfigError` thrown by slug resolver — bad shape, unknown provider. |
| 3 | `initPlugin` after `aiSdkProvider.init` (line ~100) | TTS provider failed to initialize (constructor/config error, missing dep, etc.). |
| 4 | `initPlugin` after `getProvider` (line ~109) | Provider not found after registration — defensive guard, "should never happen". |
| 5 | Outer `OpencodeSpeaker` catch (line ~42) | Anything else unexpected during init. |

`logger.error(...)` writes through `client.app.log({ body: { service, level, message, extra } })` (see `src/log.ts`). That call ends up in opencode's log file and is **invisible** to the user in the TUI. The README explicitly acknowledges this:

> **Plugin self-disables silently:** check opencode's log file — `opencode-speaker` errors are logged at `error` / `warn` level.

**API key presence is not validated anywhere today.** The AI SDK reads env vars lazily on the first call. When `OPENAI_API_KEY` is missing, the plugin logs "ready" successfully, and then either (a) the first TTS synthesis silently fails via `queue.onError → logger.warn`, or (b) the narrator's first LLM call fails via the narrator's internal try/catch which returns `null` and falls back to a template. The user sees nothing and hears nothing meaningful.

**Available surfaces** (verified against [opencode SDK docs](https://opencode.ai/docs/sdk/#tui)):

- `client.app.log(...)` — structured log entry to opencode's log file. Used today. Invisible in the TUI.
- `client.tui.showToast({ body: { message, variant } })` — in-app toast notification. Documented variants: `success` (others likely `error`, `warning`, `info` based on convention; spec uses `"error"` as a string literal and depends on the runtime accepting it).
- The `tui.toast.show` plugin event documented under [Plugins → Events → TUI](https://opencode.ai/docs/plugins/#tui-events) is the *receive* side; the SDK method above is the *send* side.

The current `ctx` passed into the plugin function exposes `client` at `ctx.client`. The codebase already accesses it via the `OpencodeClient`-shaped interface in `src/log.ts`. We will widen that shape locally (without changing the public type) so `client.tui.showToast(...)` is callable.

## 4. Architectural Decisions (Locked)

1. **Surface:** opencode TUI toast via `client.tui.showToast({ body: { message, variant: "error" } })`. Toast is *additive* to the existing structured log line — we keep the log call so power users keep their debugging surface and the toast carries the human summary.
2. **Detection scope:** all four categories above (schema, slug, missing key, TTS init), plus the outer catch-all. Audio-player-missing is explicitly out of scope.
3. **API-key check:** proactive env-var lookup based on configured provider slugs. No live network probe. Pure module, table-driven, easy to test.
4. **Module layout:** two new files (`src/notify.ts`, `src/ai-sdk/credentials.ts`) plus targeted edits in `src/index.ts`. No new dependencies.
5. **Failure isolation:** every `showToast` call is wrapped in `try/catch` and never propagates. On older opencode versions where `client.tui` does not exist, the plugin degrades to log-only — identical to today.
6. **Aggregation:** one toast per init attempt. Multiple Zod issues or multiple missing keys are merged into a single message with a separator. Toast bodies are capped at ~200 characters with an ellipsis; the structured log line carries the full unredacted detail.
7. **Logger API neutrality:** this design uses `logger.error(message, contextOrError)` which is supported both by the current logger and by the in-flight enriched-logging spec (`2026-05-31-enriched-logging-design.md`). No coupling between the two efforts.

## 5. Notify Module — `src/notify.ts`

A small factory that adapts the client + logger into a notification surface.

### 5.1 API

```ts
export interface Notifier {
  /**
   * Fatal misconfiguration. The plugin will disable itself after this call.
   * - Always logs via `logger.error(summary, detail)`.
   * - Best-effort `client.tui.showToast({ body: { message, variant: "error" } })`.
   * - Toast failures are swallowed; this function never throws.
   * - Fire-and-forget on the toast call; safe to call without await.
   */
  fatal(summary: string, detail?: unknown): void

  /**
   * Non-fatal warning. Kept symmetric with `fatal` for future use.
   * Currently unused — audio-player-missing stays a plain `logger.warn`.
   */
  warn(summary: string, detail?: unknown): void
}

export function createNotifier(
  client: NotifierClient | undefined,
  logger: Pick<Logger, "error" | "warn" | "debug">,
): Notifier

interface NotifierClient {
  tui?: {
    showToast?: (req: {
      body: { message: string; variant: "error" | "warning" | "info" | "success" }
    }) => Promise<unknown>
  }
}
```

### 5.2 Behavior

For `fatal(summary, detail)`:

1. Build the toast message as `"opencode-speaker: " + summary`. If the resulting string exceeds 200 characters, truncate to 199 characters and append `"…"` so the final body is exactly 200 characters.
2. Call `logger.error(summary, detail)` (always) — this is awaited only if the caller awaits us; we do not await it internally.
3. Check `client?.tui?.showToast`:
   - **Missing** (no `tui` property, or `tui.showToast` is not a function): do nothing further. No additional log line — this is the older-opencode case and warrants no noise.
   - **Present**: invoke it with `{ body: { message, variant: "error" } }` inside a `try/catch` so synchronous throws are caught. Attach `.catch(...)` to the returned promise. In either failure mode (sync throw or async rejection), call `logger.debug("toast surface failed", { error })`. The plugin's `return {}` proceeds immediately — the toast call is fire-and-forget, never awaited by the caller.

`warn` is identical except it uses `variant: "warning"` and `logger.warn`.

### 5.3 Boundary

- `notify.ts` does not know about credentials, models, or any other plugin internal. It does not format domain messages. Callers compose the human summary and pass it in.
- `notify.ts` does not retry. A toast that fails to land is lost; the log entry is the durable record.

## 6. Credentials Module — `src/ai-sdk/credentials.ts`

A pure module — no I/O, no dependencies beyond TypeScript built-ins.

### 6.1 API

```ts
export type SupportedProvider = "openai" | "anthropic" | "elevenlabs"

/**
 * Returns the canonical env var that the AI SDK reads for the given provider
 * slug. Returns null for unknown providers — those are surfaced as slug errors
 * by `resolveLanguageModel`/`resolveSpeechModel` in a separate step, not by us.
 *
 * Slug format: 'provider/model' (validated by SLUG_RE in models.ts).
 */
export function requiredEnvVar(providerSlug: string): string | null

export interface CredentialCheck {
  narratorSlug: string
  ttsSlug: string
}

export type CredentialResult =
  | { ok: true }
  | { ok: false; missing: string[] } // sorted, de-duplicated

/**
 * Verifies that env vars required by the configured providers are present
 * and non-empty. De-duplicates when narrator and TTS share a provider
 * (e.g., narrator=openai/x + tts=openai/y → only OPENAI_API_KEY needed).
 */
export function checkCredentials(
  check: CredentialCheck,
  env: Record<string, string | undefined>,
): CredentialResult
```

### 6.2 Provider → env var table

`requiredEnvVar(slug)` extracts the substring before the first `/` and looks it up:

| Extracted prefix | Env var |
|---|---|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `elevenlabs` | `ELEVENLABS_API_KEY` |
| any other | `null` — skipped |

If the input contains no `/` (e.g., `"openai"`), the function returns `null` — we treat malformed slugs as "unknown provider, not our problem". The slug resolver in `models.ts` is responsible for catching malformed slugs and producing a clearer error. The empty-string input also returns `null`.

### 6.3 Empty-string handling for env vars

`env[name]` is considered *missing* if it is `undefined`, the empty string, or a whitespace-only string. This matches the AI SDK's behavior (it treats empty as unset and fails on call). The check is intentionally cheap; we do not validate format (`sk-...`, etc.).

### 6.4 Boundary

- `credentials.ts` does not read `process.env` directly. The caller passes `env` so the function is trivially testable.
- It does not know about the slug regex or about which providers are supported by the slug resolver. It performs the literal prefix lookup described in §6.2. If `models.ts` grows new providers, this table grows alongside it — the duplication is intentional (one is a *parser*, the other is a *credentials map*).

## 7. Wiring in `src/index.ts`

The patch is mostly mechanical. The five existing log-error-and-return sites get a notifier call inserted; one new check is added between slug resolution and TTS init.

### 7.1 Construction

In the outer `OpencodeSpeaker(ctx, options)` `try/catch`, the logger is built inside the `catch` for last-line-of-defense logging. We do the same for the notifier:

```ts
// Outer catch (line ~42)
} catch (err) {
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

Inside `initPlugin`, the notifier is built right after the logger:

```ts
const logger = createLogger(ctx.client as any, PLUGIN_NAME)
const notifier = createNotifier(ctx.client as any, logger)
```

### 7.2 Five replacement sites

| # | Existing | After |
|---|---|---|
| 1 | `await logger.error("Invalid voice config; plugin disabled", { errors })` | `notifier.fatal(formatSchemaErrors(parsed.errors), { errors: parsed.errors })` |
| 2 | `await logger.error(\`Invalid model slug; plugin disabled: ${err.message}\`)` | `notifier.fatal(\`invalid model slug — ${err.message}\`, { error: err })` |
| 3 | `await logger.error("Failed to initialize TTS provider; plugin disabled", { error })` | `notifier.fatal(\`TTS init failed — ${oneLine(err)}\`, { error: err })` |
| 4 | `await logger.error(\`TTS provider not found after registration: ${name}\`)` | `notifier.fatal(\`provider not found after registration: ${name}\`)` |
| 5 | outer catch logger.error | (covered in §7.1 above) |

In all cases the subsequent `return {}` is unchanged.

### 7.3 New step: credentials check

Inserted between slug resolution (which produces `resolvedSpeech` and `languageModel`) and `aiSdkProvider.init(...)`:

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

This is placed *after* slug resolution so users with both a bad slug and a missing key see the slug error first (the slug is a syntactic problem; the missing key is only meaningful once we know which provider was actually requested).

### 7.4 Helper formatters (private to `index.ts` or moved to `notify.ts` if needed)

- `formatSchemaErrors(errors: { path: string; message: string }[]): string` — joins issues with `"; "`, prefixed with `"invalid config — "`. Caller-side function; lives next to its call site for now.
- `oneLine(err: unknown): string` — `String(err)` stripped of leading `"Error: "` prefix and newlines collapsed to spaces. Used so a multi-line stack from `aiSdkProvider.init` doesn't blow out the toast.

Both are pure string utilities; if either ends up needing reuse, we relocate. YAGNI for now.

### 7.5 What does NOT change

- The `cfg.enabled === false` branch (line ~70) — still a `logger.info` with no toast. Intentional opt-out.
- The audio-player init block (line ~118) — still a `logger.warn`. Operational, not a misconfig.
- `queue.onError`, `dispatcher.onError` — still `logger.warn`. Runtime, not init.
- Slash-command interception, event dispatch, the `voice` tool — entirely untouched.

## 8. Toast Content Specification

All toasts use `variant: "error"` and are prefixed with `"opencode-speaker: "`.

| Trigger | Toast body |
|---|---|
| Zod schema errors | `opencode-speaker: invalid config — tts.model must be 'provider/model'; narrator.timeoutMs must be positive` |
| Slug error (ConfigError) | `opencode-speaker: invalid model slug — Unknown TTS provider 'foo' in 'foo/bar'. Supported: openai, elevenlabs` |
| Missing API key(s) | `opencode-speaker: OPENAI_API_KEY not set; plugin disabled` or comma-joined `…: OPENAI_API_KEY, ELEVENLABS_API_KEY not set; plugin disabled` |
| TTS provider init failure | `opencode-speaker: TTS init failed — <Error.message, single line>` |
| Provider not registered (guard) | `opencode-speaker: provider not found after registration: openai` |
| Outer catch-all | `opencode-speaker: failed to initialize; plugin disabled` |

The full unredacted detail (Zod issues, error `cause`, stack) continues to flow into the structured log line. Toast bodies are capped at 200 characters; the cap is enforced inside `notify.ts` so callers do not need to remember it.

## 9. Error Handling & Graceful Degradation

- Every `client.tui.showToast` call is wrapped in `try/catch`. Synchronous throws (older opencode lacking the method) and asynchronous rejections (TUI not attached, transport error) are both caught.
- A caught toast failure logs at `debug` level only — we do not flood `error`/`warn` with toast plumbing problems when the user already has a louder reason in the log (the real init failure).
- `notifier.fatal(...)` is `void`-returning; callers do not await it. The init function proceeds to `return {}` immediately. This matters because some opencode versions may queue the toast until after the plugin's init promise resolves; awaiting could deadlock or stall startup.
- The notifier is built using a duck-typed view of `client` (`NotifierClient`). If a future opencode version reshapes `client.tui`, the optional chaining in `fatal` handles absence; we'd update the type only if a *new* shape is added.
- The plugin must never crash opencode startup. This is preserved: the outer `try/catch` in `OpencodeSpeaker(...)` already guarantees this, and the notifier respects the same contract.

## 10. Testing Strategy

Three test files. All run under the existing `vitest` setup; no new dev dependencies.

### 10.1 `test/notify.test.ts` (new)

Coverage targets:

- `fatal(summary)` calls `client.tui.showToast` exactly once with `{ body: { message: "opencode-speaker: <summary>", variant: "error" } }`.
- `fatal(summary, detail)` calls `logger.error` with `(summary, detail)`.
- When `client.tui.showToast` returns a rejected promise, `fatal` does not throw and `logger.error` is still called. A `logger.debug` is emitted noting the toast failure.
- When `client.tui.showToast` throws synchronously, same behavior as above.
- When `client.tui` is `undefined` (older opencode), `fatal` does not throw and `logger.error` is still called. No `debug` log (nothing to report — surface simply not present).
- When `client` itself is `undefined`, same.
- Message truncation: a 500-character summary produces a toast body of exactly 200 characters ending in `"…"`; `logger.error` still receives the full untruncated summary.
- `warn(...)` mirrors `fatal(...)` with `variant: "warning"` and `logger.warn`.

### 10.2 `test/credentials.test.ts` (new)

Table-driven, all branches covered:

- `requiredEnvVar('openai/gpt-4.1-mini')` → `'OPENAI_API_KEY'`
- `requiredEnvVar('anthropic/claude-haiku-4')` → `'ANTHROPIC_API_KEY'`
- `requiredEnvVar('elevenlabs/eleven_turbo_v2_5')` → `'ELEVENLABS_API_KEY'`
- `requiredEnvVar('foo/bar')` → `null`
- `requiredEnvVar('openai')` (no slash) → `null` (treated as unknown; slug resolver will catch the shape)
- `checkCredentials({ narratorSlug: 'openai/x', ttsSlug: 'openai/y' }, { OPENAI_API_KEY: 'k' })` → `{ ok: true }`
- Same with empty env → `{ ok: false, missing: ['OPENAI_API_KEY'] }`
- Same with env `{ OPENAI_API_KEY: '' }` → `{ ok: false, missing: ['OPENAI_API_KEY'] }`
- Same with env `{ OPENAI_API_KEY: '   ' }` → `{ ok: false, missing: ['OPENAI_API_KEY'] }`
- Mixed: narrator=anthropic, tts=elevenlabs, both set → `{ ok: true }`
- Mixed: narrator=anthropic, tts=elevenlabs, neither set → `{ ok: false, missing: ['ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY'] }` (sorted)
- Mixed: one supported (openai), one unknown (foo) — unknown ignored, openai checked → `{ ok: true }` if `OPENAI_API_KEY` set
- Result `missing` array is always sorted ascending and contains no duplicates.

### 10.3 `test/index.test.ts` (extend; create if absent)

Integration tests against `initPlugin` (or `OpencodeSpeaker`) with a mock `ctx`:

- Mock `client.tui.showToast` as a spy and mock `client.app.log` as a no-op.
- **Schema failure case:** pass a config with `tts: { model: "not-a-slug" }`. Assert `showToast` was called once. Assert the message matches `/invalid config — /`.
- **Missing API key case:** pass a valid config and an empty env. Assert message matches `/OPENAI_API_KEY not set/`.
- **TTS init failure case:** stub `createAiSdkProvider().init` to reject. Assert message matches `/TTS init failed — /`.
- **`enabled: false` case:** assert `showToast` was **not** called (intentional opt-out).
- **Happy path:** valid config + env. Assert `showToast` was **not** called.

The existing smoke tests in `test/` (the file list to be confirmed during implementation) remain valid — we are not changing the success path.

### 10.4 Existing test impact

Any existing test asserting on the exact error log message for one of the five sites will need updating to the new summary text. Expected to be a small set of changes (≤ 5).

## 11. Open Questions / Future Work

- **`variant` string acceptance.** The SDK docs show `"success"` as an example. We assume `"error"` and `"warning"` are accepted; if a future opencode version rejects them, the `showToast` call resolves to a falsy/error response and the plugin degrades to log-only — no crash. Implementation should `void`-ignore the showToast return value rather than branch on it.
- **Toast persistence across the user's session.** If the user dismisses the toast, the plugin will not re-show it until next startup. That is intentional for v1. A "stuck banner" surface, if opencode ever adds one, could be revisited later.
- **Runtime credential failures during operation.** If a key gets revoked mid-session, calls fail through the existing `logger.warn` paths. Surfacing those as toasts is a separate decision and is *not* in this scope — the noise/value tradeoff is different from startup.
- **Interaction with the enriched-logging spec (`2026-05-31-enriched-logging-design.md`).** This design uses `logger.error(message, contextOrError)`, which is compatible with both the current logger and the enriched one. If the enriched-logging implementation lands first, the calls here will automatically gain richer structured fields with no code changes here.
- **Custom provider registration via `opencode-speaker/api`.** Users can register their own TTS provider that does not need any of our three known env vars. Our credential check only inspects the *configured* `tts.model` slug; if it routes to a custom provider via a fork of `models.ts`, the check returns `{ ok: true }` and the custom provider's own init is responsible for its own errors. Documented as a known limitation in `requiredEnvVar`'s comment.
