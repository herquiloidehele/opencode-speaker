import { describe, it, expect, vi } from "vitest"
import { MockLanguageModelV3 } from "ai/test"
import { createNarrator } from "../src/handlers/narrator.js"

const baseConfig = { timeoutMs: 1000, minIntervalMs: 0 }

function ctx(text: string) {
  return { assistantText: text, recentTools: [] as string[] }
}

function mockResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: "stop" as const,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    warnings: [],
  }
}

function mockModel(text: string, opts: { onCall?: (input: any) => void } = {}) {
  const doGenerate = vi.fn(async (input: any) => {
    opts.onCall?.(input)
    return mockResult(text)
  })
  return { model: new MockLanguageModelV3({ doGenerate }), doGenerate }
}

describe("narrator", () => {
  it("calls model with crafted prompt and returns summary", async () => {
    let capturedPrompt = ""
    const { model, doGenerate } = mockModel("Done refactoring.", {
      onCall: (input) => {
        capturedPrompt = JSON.stringify(input)
      },
    })
    const n = createNarrator(model, baseConfig)
    const out = await n.summarize({ type: "session.idle" }, ctx("did stuff"))
    expect(out).toBe("Done refactoring.")
    expect(doGenerate).toHaveBeenCalledOnce()
    // capturedPrompt is JSON.stringify(input), which includes both the system
    // message and the per-event context, so both are assertable here.
    expect(capturedPrompt).toContain("did stuff")
    expect(capturedPrompt).toContain("First person")
    expect(capturedPrompt).toContain("say it aloud")
    expect(capturedPrompt).not.toContain("Do not refer to the agent")
  })

  it("returns null without calling the model when context is empty", async () => {
    const { model, doGenerate } = mockModel("should not be used")
    const n = createNarrator(model, baseConfig)
    const out = await n.summarize({ type: "session.idle" }, ctx(""))
    expect(out).toBeNull()
    expect(doGenerate).not.toHaveBeenCalled()
  })

  it("surfaces normalized event fields in the prompt", async () => {
    let capturedPrompt = ""
    const { model } = mockModel("ok", {
      onCall: (input) => {
        capturedPrompt = JSON.stringify(input)
      },
    })
    const n = createNarrator(model, baseConfig)
    await n.summarize(
      { type: "session.idle", message: "Model overloaded", errorName: "UnknownError" },
      ctx("tried a request"),
    )
    expect(capturedPrompt).toContain("Model overloaded")
    expect(capturedPrompt).toContain("UnknownError")
  })

  it("uses catalog narration occasion text", async () => {
    let capturedPrompt = ""
    const { model } = mockModel("Done.", {
      onCall: (input) => {
        capturedPrompt = JSON.stringify(input)
      },
    })
    const n = createNarrator(model, baseConfig)

    await n.summarize({ type: "todo.completed.all" }, ctx("finished the list"))

    expect(capturedPrompt).toContain("I just finished everything on my todo list.")
  })

  it("returns null when timeout elapses", async () => {
    const doGenerate = vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500)
        abortSignal?.addEventListener("abort", () => {
          clearTimeout(t)
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
      // If we ever get here the signal wasn't honoured — fail loudly.
      throw new Error("should have aborted")
    })
    const model = new MockLanguageModelV3({ doGenerate })
    const n = createNarrator(model, { ...baseConfig, timeoutMs: 20 })
    const out = await n.summarize({ type: "session.idle" }, ctx("x"))
    expect(out).toBeNull()
  })

  it("returns null when model errors", async () => {
    const doGenerate = vi.fn(async () => {
      throw new Error("500")
    })
    const model = new MockLanguageModelV3({ doGenerate })
    const n = createNarrator(model, baseConfig)
    const out = await n.summarize({ type: "session.idle" }, ctx("x"))
    expect(out).toBeNull()
  })

  it("returns null when response text is empty", async () => {
    const { model } = mockModel("")
    const n = createNarrator(model, baseConfig)
    const out = await n.summarize({ type: "session.idle" }, ctx("x"))
    expect(out).toBeNull()
  })

  it("throttles within minIntervalMs returning null", async () => {
    const { model, doGenerate } = mockModel("ok")
    const n = createNarrator(model, { ...baseConfig, minIntervalMs: 100_000 })
    const first = await n.summarize({ type: "session.idle" }, ctx("x"))
    const second = await n.summarize({ type: "session.idle" }, ctx("x"))
    expect(first).toBe("ok")
    expect(second).toBeNull()
    expect(doGenerate).toHaveBeenCalledOnce()
  })

  it("truncates very long assistant text in the prompt", async () => {
    let capturedPrompt = ""
    const { model } = mockModel("ok", {
      onCall: (input) => {
        capturedPrompt = JSON.stringify(input)
      },
    })
    const n = createNarrator(model, baseConfig)
    const long = "x".repeat(20_000)
    await n.summarize({ type: "session.idle" }, ctx(long))
    // The narrator caps assistant text at 10000 chars before it reaches the
    // model, so a 20k-char input must not be passed verbatim.
    const xRun = capturedPrompt.match(/x+/)?.[0] ?? ""
    expect(xRun.length).toBeGreaterThan(0)
    expect(xRun.length).toBeLessThanOrEqual(10000)
  })

  it("does not advance throttle on error", async () => {
    let calls = 0
    const doGenerate = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error("transient")
      return mockResult("second")
    })
    const model = new MockLanguageModelV3({ doGenerate })
    const n = createNarrator(model, { ...baseConfig, minIntervalMs: 100_000 })
    const first = await n.summarize({ type: "session.idle" }, ctx("x"))
    const second = await n.summarize({ type: "session.idle" }, ctx("x"))
    expect(first).toBeNull()
    expect(second).toBe("second")
  })
})

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
    const doGenerate = vi.fn(async () => {
      throw new Error("LM down")
    })
    const model = new MockLanguageModelV3({ doGenerate })
    const narrator = createNarrator(model, baseConfig, logger)
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
    const doGenerate = vi.fn(async () => {
      throw new Error("x")
    })
    const model = new MockLanguageModelV3({ doGenerate })
    const narrator = createNarrator(model, baseConfig)
    const result = await narrator.summarize(
      { type: "session.idle" },
      { assistantText: "", recentTools: [] },
    )
    expect(result).toBeNull()
  })
})
