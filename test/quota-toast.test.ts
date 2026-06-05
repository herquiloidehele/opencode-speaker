import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

function baseCtx() {
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

describe("OpencodeSpeaker quota-error toasts", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubEnv("OPENAI_API_KEY", "test-key-without-quota")
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("shows one error toast and suppresses later speech after TTS quota failure", async () => {
    const quotaError = Object.assign(
      new Error(
        "Failed after 3 attempts. Last error: You exceeded your current quota, please check your plan and billing details.",
      ),
      { name: "AI_RetryError" },
    )
    const synthesize = vi.fn().mockRejectedValue(quotaError)

    vi.doMock("../src/tts/ai-sdk.js", () => ({
      createAiSdkProvider: vi.fn(() => ({ name: "openai", synthesize })),
    }))
    vi.doMock("../src/audio/runner.js", () => ({
      defaultRunner: vi.fn(async () => vi.fn()),
    }))
    vi.doMock("../src/audio/player.js", () => ({
      createPlayer: vi.fn(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        play: vi.fn().mockResolvedValue(undefined),
      })),
    }))

    const { OpencodeSpeaker } = await import("../src/index.js")
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      greeting: "hello",
      events: {
        "session.idle": { enabled: true, mode: "template" },
      },
    })) as any

    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2500)

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.variant).toBe("error")
    expect(showToast.mock.calls[0][0].body.message).toMatch(
      /TTS quota exceeded; speech disabled for this session/,
    )

    await hooks.event({ event: { type: "session.idle" } })
    await vi.runOnlyPendingTimersAsync()

    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it("shows the same generic toast for non-OpenAI provider quota failures", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "test-elevenlabs-key-without-quota")
    const quotaError = new Error("ElevenLabs quota exceeded")
    const synthesize = vi.fn().mockRejectedValue(quotaError)

    vi.doMock("../src/tts/ai-sdk.js", () => ({
      createAiSdkProvider: vi.fn(() => ({ name: "elevenlabs", synthesize })),
    }))
    vi.doMock("../src/audio/runner.js", () => ({
      defaultRunner: vi.fn(async () => vi.fn()),
    }))
    vi.doMock("../src/audio/player.js", () => ({
      createPlayer: vi.fn(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        play: vi.fn().mockResolvedValue(undefined),
      })),
    }))

    const { OpencodeSpeaker } = await import("../src/index.js")
    const { ctx, showToast } = baseCtx()
    await OpencodeSpeaker(ctx, {
      greeting: "hello",
      tts: { model: "elevenlabs/eleven_turbo_v2_5" },
    })

    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2500)

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.message).toMatch(
      /TTS quota exceeded; speech disabled for this session/,
    )
  })

  it("shows one error toast and suppresses later speech after startup TTS failure", async () => {
    const synthesize = vi.fn().mockRejectedValue(new Error("Incorrect API key provided"))

    vi.doMock("../src/tts/ai-sdk.js", () => ({
      createAiSdkProvider: vi.fn(() => ({ name: "openai", synthesize })),
    }))
    vi.doMock("../src/audio/runner.js", () => ({
      defaultRunner: vi.fn(async () => vi.fn()),
    }))
    vi.doMock("../src/audio/player.js", () => ({
      createPlayer: vi.fn(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        play: vi.fn().mockResolvedValue(undefined),
      })),
    }))

    const { OpencodeSpeaker } = await import("../src/index.js")
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      greeting: "hello",
      events: {
        "session.idle": { enabled: true, mode: "template" },
      },
    })) as any

    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2500)

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast.mock.calls[0][0].body.variant).toBe("error")
    expect(showToast.mock.calls[0][0].body.message).toMatch(
      /TTS failed during startup; speech disabled for this session/,
    )

    await hooks.event({ event: { type: "session.idle" } })
    await vi.runOnlyPendingTimersAsync()

    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it("does not toast ordinary runtime synthesis failures", async () => {
    const synthesize = vi.fn().mockRejectedValue(new Error("temporary network failure"))

    vi.doMock("../src/tts/ai-sdk.js", () => ({
      createAiSdkProvider: vi.fn(() => ({ name: "openai", synthesize })),
    }))
    vi.doMock("../src/audio/runner.js", () => ({
      defaultRunner: vi.fn(async () => vi.fn()),
    }))
    vi.doMock("../src/audio/player.js", () => ({
      createPlayer: vi.fn(() => ({
        init: vi.fn().mockResolvedValue(undefined),
        play: vi.fn().mockResolvedValue(undefined),
      })),
    }))

    const { OpencodeSpeaker } = await import("../src/index.js")
    const { ctx, showToast } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {
      greeting: "",
      events: {
        "session.idle": { enabled: true, mode: "template" },
      },
    })) as any

    await hooks.event({ event: { type: "session.idle" } })

    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(2500)

    expect(showToast).not.toHaveBeenCalled()
    expect(synthesize).toHaveBeenCalledTimes(1)
  })
})
