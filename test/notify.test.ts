import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createNotifier } from "../src/notify.js"

function makeLogger() {
  return {
    error: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    info: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  }
}

describe("createNotifier.fatal", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("calls showToast once with error variant, prefixed message, and duration (after defer)", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    notifier.fatal("invalid config — tts.model bad")

    // Toast is deferred; nothing happens synchronously.
    expect(showToast).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2500)

    expect(showToast).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith({
      body: {
        message: "opencode-speaker: invalid config — tts.model bad",
        variant: "error",
        duration: 10000,
      },
    })
  })

  it("also calls logger.error with summary and detail (synchronously)", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)
    const detail = { errors: [{ path: "tts.model", message: "bad" }] }

    notifier.fatal("invalid config", detail)

    // logger.error is called synchronously, not deferred.
    expect(logger.error).toHaveBeenCalledWith("invalid config", detail)
  })

  it("returns synchronously; defers the actual toast call", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const notifier = createNotifier({ tui: { showToast } }, makeLogger())

    notifier.fatal("hi")
    expect(showToast).not.toHaveBeenCalled()
  })

  it("does not throw when showToast rejects; logs result after timer fires", async () => {
    const showToast = vi.fn().mockRejectedValue(new Error("boom"))
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    await vi.advanceTimersByTimeAsync(2500)

    expect(logger.info).toHaveBeenCalledWith(
      "[diag] toast surface failed",
      expect.objectContaining({ error: expect.any(Error) }),
    )
  })

  it("does not throw when showToast throws synchronously; logs threw after timer fires", async () => {
    const showToast = vi.fn().mockImplementation(() => {
      throw new Error("sync boom")
    })
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    await vi.advanceTimersByTimeAsync(2500)

    expect(logger.info).toHaveBeenCalledWith(
      "[diag] toast surface threw",
      expect.objectContaining({ error: expect.any(Error) }),
    )
  })

  it("logs unavailable when client.tui is missing (after timer fires)", async () => {
    const logger = makeLogger()
    const notifier = createNotifier({}, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    expect(logger.error).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2500)
    expect(logger.info).toHaveBeenCalledWith(
      "[diag] toast surface unavailable",
      expect.any(Object),
    )
  })

  it("logs unavailable when client is undefined (after timer fires)", async () => {
    const logger = makeLogger()
    const notifier = createNotifier(undefined, logger)

    expect(() => notifier.fatal("hi")).not.toThrow()
    expect(logger.error).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2500)
    expect(logger.info).toHaveBeenCalledWith(
      "[diag] toast surface unavailable",
      expect.any(Object),
    )
  })

  it("truncates the toast body to exactly 200 chars with ellipsis", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const notifier = createNotifier({ tui: { showToast } }, makeLogger())
    const longSummary = "x".repeat(500)

    notifier.fatal(longSummary)
    vi.advanceTimersByTime(2500)

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
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("uses warning variant and logger.warn", () => {
    const showToast = vi.fn().mockResolvedValue(true)
    const logger = makeLogger()
    const notifier = createNotifier({ tui: { showToast } }, logger)

    notifier.warn("audio player missing")

    // logger.warn is synchronous; showToast is deferred.
    expect(logger.warn).toHaveBeenCalledWith("audio player missing", undefined)
    expect(logger.error).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2500)

    expect(showToast).toHaveBeenCalledWith({
      body: {
        message: "opencode-speaker: audio player missing",
        variant: "warning",
        duration: 10000,
      },
    })
  })
})
