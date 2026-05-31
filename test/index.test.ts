import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import OpencodeSpeakerDefault, { OpencodeSpeaker } from "../src/index.js"
import { DEFAULT_TTS_MODEL, ENV_DISABLED } from "../src/config.js"

describe("opencode-speaker plugin module shape", () => {
  it("default-exports the plugin function itself (current opencode contract)", () => {
    // opencode's current plugin loader expects `default` to be the async
    // plugin function — not a `{ id, server }` wrapper. The older wrapper
    // shape causes a "does not expose a server entrypoint" warning and the
    // plugin is silently skipped at runtime.
    expect(typeof OpencodeSpeakerDefault).toBe("function")
    expect(OpencodeSpeakerDefault).toBe(OpencodeSpeaker)
  })

  it("module does not export anything other than the plugin function and its default", async () => {
    // Critical for compatibility with opencode's plugin scanner. Any
    // additional exported function could be invoked as a separate plugin.
    const mod = await import("../src/index.js")
    const exportedKeys = Object.keys(mod).filter((k) => k !== "default")
    expect(exportedKeys).toEqual(["OpencodeSpeaker"])
  })
})

describe("OpencodeSpeaker plugin", () => {
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

  it(`returns an empty (no-op) hooks object when ${ENV_DISABLED}=1`, async () => {
    const oldEnv = process.env[ENV_DISABLED]
    process.env[ENV_DISABLED] = "1"
    try {
      const { ctx } = baseCtx()
      const hooks = await OpencodeSpeaker(ctx, {})
      expect(hooks).toEqual({})
    } finally {
      if (oldEnv === undefined) delete process.env[ENV_DISABLED]
      else process.env[ENV_DISABLED] = oldEnv
    }
  })

  it("registers an `event` hook that does not throw on unknown events", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { events: {} })) as any
    expect(typeof hooks.event).toBe("function")
    await expect(
      hooks.event({ event: { type: "some.unknown.event" } }),
    ).resolves.toBeUndefined()
  })

  it("registers a `voice` custom tool", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {})) as any
    expect(hooks.tool?.voice).toBeDefined()
  })

  it("accepts options as the second argument (opencode's plugin contract)", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      tts: { model: DEFAULT_TTS_MODEL },
      // Keep the greeting from pushing onto the queue and triggering a
      // background synthesize() call (which would fail without OPENAI_API_KEY).
      startMuted: true,
    })) as any
    // Initialization should succeed (returns hooks object, not {}).
    expect(typeof hooks.event).toBe("function")
  })

  it("falls back to defaults when options is undefined", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, undefined)) as any
    expect(typeof hooks.event).toBe("function")
  })
})

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
    vi.useFakeTimers()
    vi.stubEnv("OPENAI_API_KEY", "test-key-for-init")
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it("toasts when the config has a schema error", async () => {
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      tts: { model: "not-a-slug" },
    })) as any
    expect(hooks).toEqual({})
    vi.advanceTimersByTime(2500)
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
    vi.advanceTimersByTime(2500)
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
    vi.advanceTimersByTime(2500)
    expect(showToast).toHaveBeenCalledTimes(1)
    const msg = showToast.mock.calls[0][0].body.message
    expect(msg).toMatch(/ANTHROPIC_API_KEY/)
    expect(msg).toMatch(/ELEVENLABS_API_KEY/)
  })

  it("does NOT toast when enabled is false (intentional opt-out)", async () => {
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { enabled: false })) as any
    expect(hooks).toEqual({})
    vi.advanceTimersByTime(2500)
    expect(showToast).not.toHaveBeenCalled()
  })

  it("does NOT toast on the happy path", async () => {
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, { startMuted: true })) as any
    expect(typeof hooks.event).toBe("function")
    vi.advanceTimersByTime(2500)
    expect(showToast).not.toHaveBeenCalled()
  })
})
