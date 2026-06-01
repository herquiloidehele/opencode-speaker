# Passive TTY Hotkeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LLM-routed voice slash commands and the `voice` tool with passive TTY hotkeys for stopping and muting speech.

**Architecture:** Add focused control modules under `src/control/`: one for matching passive stdin hotkeys and one for the shared signal-file bus used to sync multiple opencode instances. Wire both into plugin startup before the greeting, return a disposer, and remove the old slash-command/tool control surface.

**Tech Stack:** TypeScript ESM, Node streams/fs/path/os APIs, Vitest, existing `SpeechQueue`/`Commands` abstractions.

---

## File Structure

- Create `src/control/hotkeys.ts`: parse configured hotkey names/literals, attach/remove passive stdin listeners, dispatch stop/mute callbacks.
- Create `src/control/signals.ts`: resolve signal directory, poll `stop` and `mute` files, publish stop and mute changes for multi-instance sync.
- Modify `src/config.ts`: add `control` config schema and defaults.
- Modify `src/index.ts`: remove voice tool and slash command interception; start control modules; return `dispose`.
- Delete `src/tools/voice-tool.ts`, `src/commands/shortcuts.ts`, and `src/commands/actions.ts` if no imports remain.
- Delete `test/voice-tool.test.ts` and `test/commands-shortcuts.test.ts`.
- Create `test/control-hotkeys.test.ts` and `test/control-signals.test.ts`.
- Modify `test/config.test.ts`, `test/index.test.ts`, and `README.md`.

---

### Task 1: Add Control Config

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 1: Write failing config tests**

Append tests inside `describe("parseConfig", ...)` in `test/config.test.ts`:

```ts
  it("defaults passive control and hotkeys", () => {
    const result = parseConfig({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.control.enabled).toBe(true)
      expect(result.config.control.pollMs).toBe(200)
      expect(result.config.control.signalDir).toBeUndefined()
      expect(result.config.control.hotkeys.enabled).toBe(true)
      expect(result.config.control.hotkeys.stop).toBe("f8")
      expect(result.config.control.hotkeys.muteToggle).toBe("f9")
    }
  })

  it("allows overriding passive control options", () => {
    const result = parseConfig({
      control: {
        enabled: false,
        signalDir: "/tmp/opencode-speaker-test",
        pollMs: 75,
        hotkeys: {
          enabled: false,
          stop: "\\u001b[19~",
          muteToggle: "\\u001b[20~",
        },
      },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.control.enabled).toBe(false)
      expect(result.config.control.signalDir).toBe("/tmp/opencode-speaker-test")
      expect(result.config.control.pollMs).toBe(75)
      expect(result.config.control.hotkeys.enabled).toBe(false)
      expect(result.config.control.hotkeys.stop).toBe("\\u001b[19~")
      expect(result.config.control.hotkeys.muteToggle).toBe("\\u001b[20~")
    }
  })

  it("rejects invalid passive control options", () => {
    expect(parseConfig({ control: { pollMs: 49 } }).ok).toBe(false)
    expect(parseConfig({ control: { signalDir: "" } }).ok).toBe(false)
    expect(parseConfig({ control: { hotkeys: { stop: "" } } }).ok).toBe(false)
  })
```

- [ ] **Step 2: Run config tests and verify failure**

Run: `npm test -- test/config.test.ts`

Expected: FAIL because `control` does not exist on `VoiceConfig`.

- [ ] **Step 3: Add config schema**

In `src/config.ts`, add schemas before `VoiceConfigSchema`:

```ts
const HotkeysSchema = z.object({
  enabled: z.boolean().default(true),
  stop: z.string().min(1).default("f8"),
  muteToggle: z.string().min(1).default("f9"),
}).default({})

const ControlSchema = z.object({
  enabled: z.boolean().default(true),
  signalDir: z.string().min(1).optional(),
  pollMs: z.number().int().min(50).default(200),
  hotkeys: HotkeysSchema,
}).default({})
```

Add `control: ControlSchema,` to `VoiceConfigSchema`.

- [ ] **Step 4: Run config tests and verify pass**

Run: `npm test -- test/config.test.ts`

Expected: PASS.

---

### Task 2: Implement Passive Hotkey Matching

**Files:**
- Create: `src/control/hotkeys.ts`
- Create: `test/control-hotkeys.test.ts`

- [ ] **Step 1: Write failing hotkey tests**

Create `test/control-hotkeys.test.ts`:

```ts
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { createHotkeyListener, resolveKeySequences } from "../src/control/hotkeys.js"

class FakeInput extends EventEmitter {
  listenerCountForData() {
    return this.listenerCount("data")
  }
}

describe("resolveKeySequences", () => {
  it("expands named f8 and f9 defaults", () => {
    expect(resolveKeySequences("f8")).toContain("\u001b[19~")
    expect(resolveKeySequences("f9")).toContain("\u001b[20~")
  })

  it("accepts literal escape sequences", () => {
    expect(resolveKeySequences("\u001b[99~")).toEqual(["\u001b[99~"])
  })
})

describe("createHotkeyListener", () => {
  it("calls stop when F8 arrives", () => {
    const input = new FakeInput()
    const onStop = vi.fn()
    const dispose = createHotkeyListener({
      input: input as any,
      stop: "f8",
      muteToggle: "f9",
      onStop,
      onMuteToggle: vi.fn(),
    })

    input.emit("data", Buffer.from("\u001b[19~"))

    expect(onStop).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("calls mute toggle when F9 arrives", () => {
    const input = new FakeInput()
    const onMuteToggle = vi.fn()
    const dispose = createHotkeyListener({
      input: input as any,
      stop: "f8",
      muteToggle: "f9",
      onStop: vi.fn(),
      onMuteToggle,
    })

    input.emit("data", Buffer.from("\u001b[20~"))

    expect(onMuteToggle).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("removes the data listener on dispose", () => {
    const input = new FakeInput()
    const dispose = createHotkeyListener({
      input: input as any,
      stop: "f8",
      muteToggle: "f9",
      onStop: vi.fn(),
      onMuteToggle: vi.fn(),
    })
    expect(input.listenerCountForData()).toBe(1)
    dispose()
    expect(input.listenerCountForData()).toBe(0)
  })
})
```

- [ ] **Step 2: Run hotkey tests and verify failure**

Run: `npm test -- test/control-hotkeys.test.ts`
Expected: FAIL because `src/control/hotkeys.ts` does not exist.

- [ ] **Step 3: Implement `src/control/hotkeys.ts`**

Create:

```ts
import type { Readable } from "node:stream"

type InputStream = Pick<Readable, "on" | "off">

export interface HotkeyListenerOptions {
  input?: InputStream
  stop: string
  muteToggle: string
  onStop(): void
  onMuteToggle(): void
  onError?: (err: unknown) => void
}

const NAMED_KEYS: Record<string, string[]> = {
  f8: ["\u001b[19~", "\u001b[19;2~", "\u001b[19;5~"],
  f9: ["\u001b[20~", "\u001b[20;2~", "\u001b[20;5~"],
}

export function resolveKeySequences(value: string): string[] {
  const normalized = value.trim().toLowerCase()
  return NAMED_KEYS[normalized] ?? [value]
}

export function createHotkeyListener(opts: HotkeyListenerOptions): () => void {
  const input = opts.input ?? process.stdin
  const stopSequences = resolveKeySequences(opts.stop)
  const muteSequences = resolveKeySequences(opts.muteToggle)
  const maxLen = Math.max(
    1,
    ...stopSequences.map((s) => s.length),
    ...muteSequences.map((s) => s.length),
  )
  let suffix = ""

  function handleData(chunk: unknown) {
    try {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
      suffix = (suffix + text).slice(-maxLen)
      if (stopSequences.some((seq) => suffix.endsWith(seq))) {
        opts.onStop()
        return
      }
      if (muteSequences.some((seq) => suffix.endsWith(seq))) {
        opts.onMuteToggle()
      }
    } catch (err) {
      opts.onError?.(err)
    }
  }

  input.on("data", handleData)
  return () => input.off("data", handleData)
}
```

- [ ] **Step 4: Run hotkey tests and verify pass**

Run: `npm test -- test/control-hotkeys.test.ts`
Expected: PASS.

---

### Task 3: Implement Shared Signal Bus

**Files:**
- Create: `src/control/signals.ts`
- Create: `test/control-signals.test.ts`

- [ ] **Step 1: Write failing signal tests**

Create `test/control-signals.test.ts`:

```ts
import { mkdtemp, rm, stat, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSignalBus, publishMuteState, publishStopSignal } from "../src/control/signals.js"

let dirs: string[] = []

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "opencode-speaker-signals-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

describe("signal bus", () => {
  it("ignores stale stop file on startup", async () => {
    vi.useFakeTimers()
    const dir = await tempDir()
    await writeFile(join(dir, "stop"), "old")
    const onStop = vi.fn()

    const bus = await createSignalBus({ signalDir: dir, pollMs: 50, onStop, onMuteChange: vi.fn() })
    await vi.advanceTimersByTimeAsync(100)

    expect(onStop).not.toHaveBeenCalled()
    bus.dispose()
  })

  it("publishes and observes stop signals", async () => {
    vi.useFakeTimers()
    const dir = await tempDir()
    const onStop = vi.fn()
    const bus = await createSignalBus({ signalDir: dir, pollMs: 50, onStop, onMuteChange: vi.fn() })

    await publishStopSignal(dir)
    await vi.advanceTimersByTimeAsync(100)

    expect(onStop).toHaveBeenCalledTimes(1)
    bus.dispose()
  })

  it("publishes and observes mute presence", async () => {
    vi.useFakeTimers()
    const dir = await tempDir()
    const onMuteChange = vi.fn()
    const bus = await createSignalBus({ signalDir: dir, pollMs: 50, onStop: vi.fn(), onMuteChange })

    await publishMuteState(dir, true)
    await vi.advanceTimersByTimeAsync(100)
    await publishMuteState(dir, false)
    await vi.advanceTimersByTimeAsync(100)

    expect(onMuteChange).toHaveBeenCalledWith(true)
    expect(onMuteChange).toHaveBeenCalledWith(false)
    bus.dispose()
  })

  it("resolves mute state from the file system", async () => {
    const dir = await tempDir()
    await publishMuteState(dir, true)
    await expect(stat(join(dir, "mute"))).resolves.toBeDefined()
    await publishMuteState(dir, false)
    await expect(stat(join(dir, "mute"))).rejects.toBeTruthy()
  })
})
```

- [ ] **Step 2: Run signal tests and verify failure**

Run: `npm test -- test/control-signals.test.ts`
Expected: FAIL because `src/control/signals.ts` does not exist.

- [ ] **Step 3: Implement `src/control/signals.ts`**

Create:

```ts
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

export interface SignalBusOptions {
  signalDir?: string
  pollMs: number
  onStop(): void
  onMuteChange(muted: boolean): void
  onError?: (err: unknown) => void
}

export interface SignalBus {
  signalDir: string
  initialMuted: boolean
  dispose(): void
}

function defaultCacheDir(): string {
  return process.env.XDG_CACHE_HOME || join(homedir() || tmpdir(), ".cache")
}

export function resolveSignalDir(signalDir?: string): string {
  return signalDir ?? join(defaultCacheDir(), "opencode-speaker")
}

async function fileMtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await fileMtime(path)) !== null
}

export async function publishStopSignal(signalDir: string): Promise<void> {
  await mkdir(signalDir, { recursive: true })
  const path = join(signalDir, "stop")
  const handle = await open(path, "a")
  await handle.close()
  const now = new Date()
  await writeFile(path, String(now.getTime()))
}

export async function publishMuteState(signalDir: string, muted: boolean): Promise<void> {
  await mkdir(dirname(join(signalDir, "mute")), { recursive: true })
  const path = join(signalDir, "mute")
  if (muted) await writeFile(path, "muted")
  else await rm(path, { force: true })
}

export async function createSignalBus(opts: SignalBusOptions): Promise<SignalBus> {
  const signalDir = resolveSignalDir(opts.signalDir)
  await mkdir(signalDir, { recursive: true })
  const stopPath = join(signalDir, "stop")
  const mutePath = join(signalDir, "mute")
  let lastStopMtime = await fileMtime(stopPath)
  let lastMuted = await fileExists(mutePath)
  let disposed = false

  async function poll() {
    if (disposed) return
    try {
      const stopMtime = await fileMtime(stopPath)
      if (stopMtime !== null && (lastStopMtime === null || stopMtime > lastStopMtime)) {
        lastStopMtime = stopMtime
        opts.onStop()
      } else if (stopMtime !== null) {
        lastStopMtime = stopMtime
      }

      const muted = await fileExists(mutePath)
      if (muted !== lastMuted) {
        lastMuted = muted
        opts.onMuteChange(muted)
      }
    } catch (err) {
      opts.onError?.(err)
    }
  }

  const timer = setInterval(() => void poll(), opts.pollMs)
  return {
    signalDir,
    initialMuted: lastMuted,
    dispose() {
      disposed = true
      clearInterval(timer)
    },
  }
}
```

- [ ] **Step 4: Run signal tests and verify pass**

Run: `npm test -- test/control-signals.test.ts`
Expected: PASS.

---

### Task 4: Wire Control Into Plugin and Remove Old Hooks

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

- [ ] **Step 1: Update index tests first**

In `test/index.test.ts`, replace `registers a voice custom tool` with:

```ts
  it("does not register the old `voice` custom tool", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { startMuted: true })) as any
    expect(hooks.tool?.voice).toBeUndefined()
  })
```

Add:

```ts
  it("returns a dispose hook when control is enabled", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { startMuted: true })) as any
    expect(typeof hooks.dispose).toBe("function")
    await hooks.dispose()
  })

  it("omits the dispose hook when control is disabled", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      startMuted: true,
      control: { enabled: false },
    })) as any
    expect(hooks.dispose).toBeUndefined()
  })
```

- [ ] **Step 2: Run index tests and verify failure**

Run: `npm test -- test/index.test.ts`
Expected: FAIL because `tool.voice` still exists and no `dispose` is returned.

- [ ] **Step 3: Modify `src/index.ts` imports**

Remove:

```ts
import { createShortcutHandlers, extractCommandName } from "./commands/shortcuts.js"
import { createVoiceTool } from "./tools/voice-tool.js"
```

Add:

```ts
import { createHotkeyListener } from "./control/hotkeys.js"
import {
  createSignalBus,
  publishMuteState,
  publishStopSignal,
} from "./control/signals.js"
```

- [ ] **Step 4: Start control after commands are created**

After `if (config.startMuted) commands.mute()`, add minimal control wiring:

```ts
  const disposers: Array<() => void | Promise<void>> = []
  let signalDir: string | undefined

  if (config.control.enabled) {
    try {
      const bus = await createSignalBus({
        signalDir: config.control.signalDir,
        pollMs: config.control.pollMs,
        onStop: () => commands.stop(),
        onMuteChange: (muted) => {
          if (muted) commands.mute()
          else commands.unmute()
        },
        onError: (err) => {
          void initLog.warn("voice control signal polling failed", {
            error: err,
            operation: "polling voice control signals",
          })
        },
      })
      signalDir = bus.signalDir
      disposers.push(bus.dispose)
      if (bus.initialMuted) commands.mute()

      if (config.control.hotkeys.enabled) {
        disposers.push(createHotkeyListener({
          stop: config.control.hotkeys.stop,
          muteToggle: config.control.hotkeys.muteToggle,
          onStop: () => {
            commands.stop()
            if (signalDir) void publishStopSignal(signalDir)
          },
          onMuteToggle: () => {
            const muted = !commands.isMuted()
            if (muted) commands.mute()
            else commands.unmute()
            if (signalDir) void publishMuteState(signalDir, muted)
          },
          onError: (err) => {
            void initLog.warn("voice control hotkey failed", {
              error: err,
              operation: "handling voice control hotkey",
            })
          },
        }))
      }
    } catch (err) {
      await initLog.warn("voice control unavailable", {
        error: err,
        operation: "starting voice control",
      })
    }
  }
```

- [ ] **Step 5: Remove old slash interception and tool return**

Delete the `shortcutHandlers` block and the `tool: { voice: createVoiceTool(commands) }` return entry.

Add `dispose` only when needed:

```ts
  const hooks: {
    event: (input: { event: { type: string; [k: string]: unknown } }) => Promise<void>
    dispose?: () => Promise<void>
  } = {
    event: async ({ event }) => {
      try {
        await dispatcher.onEvent(event)
      } catch (err) {
        await dispatchLog.warn("event handler crashed", {
          error: err,
          operation: "dispatching opencode event",
          input: { eventType: event.type },
        })
      }
    },
  }

  if (disposers.length > 0) {
    hooks.dispose = async () => {
      for (const dispose of disposers.splice(0)) await dispose()
    }
  }

  return hooks
```

- [ ] **Step 6: Run index tests and verify pass**

Run: `npm test -- test/index.test.ts`
Expected: PASS.

---

### Task 5: Delete Old Control Files and Tests

**Files:**
- Delete: `src/tools/voice-tool.ts`
- Delete: `src/commands/shortcuts.ts`
- Delete: `src/commands/actions.ts`
- Delete: `test/voice-tool.test.ts`
- Delete: `test/commands-shortcuts.test.ts`

- [ ] **Step 1: Delete obsolete files**

Remove `src/tools/voice-tool.ts`, `src/commands/shortcuts.ts`, `src/commands/actions.ts`, `test/voice-tool.test.ts`, and `test/commands-shortcuts.test.ts` after confirming no imports remain.

- [ ] **Step 2: Search for stale imports and docs references**

Run: `npm test -- test/control-hotkeys.test.ts test/control-signals.test.ts test/config.test.ts test/index.test.ts`
Expected: PASS. If TypeScript/Vitest reports missing imports, remove the stale import or test.

---

### Task 6: Update README Controls Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace controls section**

Replace README lines under `## Controls` with:

```md
## Controls

### Passive hotkeys

By default, opencode-speaker listens passively for function keys while the opencode terminal is focused:

| Key | Effect |
|---|---|
| `F8` | Interrupt current speech and drop the speech queue. Future events can still speak. |
| `F9` | Toggle mute. Muting interrupts current speech, drops the queue, and silences future events until unmuted. |

These hotkeys do not send prompts to the agent, do not call tools, and do not interrupt session generation. They also work after a generation has finished, as long as the opencode terminal is focused.

Multiple running opencode-speaker instances sync stop/mute state through an internal signal directory, so pressing `F8` or `F9` in the focused window controls the others too.

Configure or disable them in the plugin options:

```jsonc
{
  "plugin": [
    ["opencode-speaker", {
      "control": {
        "enabled": true,
        "hotkeys": {
          "enabled": true,
          "stop": "f8",
          "muteToggle": "f9"
        }
      }
    }]
  ]
}
```

If your terminal sends a different function-key sequence, set a literal JSON-escaped sequence instead:

```jsonc
{
  "control": {
    "hotkeys": {
      "stop": "\u001b[19~",
      "muteToggle": "\u001b[20~"
    }
  }
}
```
```

- [ ] **Step 2: Search README for old controls**

Use content search for `/voice-stop`, `/voice-off`, and `voice tool`. Expected: no remaining references to old slash commands or voice tool.

---

### Task 7: Final Verification

**Files:**
- All touched files

- [ ] **Step 1: Run full tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Review working tree**

Run: `git status --short`
Expected: only intended files changed. Do not commit unless the user explicitly asks.

---

## Self-Review

- Spec coverage: tasks cover config, passive stdin hotkeys, internal signal bus, multi-instance sync, removal of slash/tool controls, docs, and verification.
- Placeholder scan: no unfinished placeholder markers remain.
- Type consistency: config uses `control.enabled`, `control.signalDir`, `control.pollMs`, `control.hotkeys.enabled`, `control.hotkeys.stop`, and `control.hotkeys.muteToggle` consistently across plan tasks.
