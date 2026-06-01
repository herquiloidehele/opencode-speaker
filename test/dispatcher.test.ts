import { describe, it, expect, vi } from "vitest"
import { createDispatcher } from "../src/dispatcher.js"

describe("dispatcher", () => {
  it("forwards plain events to the handler", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({ type: "session.idle" })
    expect(handle).toHaveBeenCalledWith({ type: "session.idle" })
  })

  it("pushes returned SpeechRequest to the queue", async () => {
    const req = { id: "x", priority: 2, text: "hi", enqueuedAt: 0 }
    const handle = vi.fn().mockResolvedValue(req)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({ type: "session.error" })
    expect(push).toHaveBeenCalledWith(req)
  })

  it("derives todo.completed.item from todo.updated transitions", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({
      type: "todo.updated",
      todos: [{ id: "1", content: "A", status: "pending" }],
    })
    await d.onEvent({
      type: "todo.updated",
      todos: [{ id: "1", content: "A", status: "completed" }],
    })
    const types = handle.mock.calls.map(([e]) => e.type)
    expect(types).toContain("todo.completed.item")
    const itemEvent = handle.mock.calls.find(([e]) => e.type === "todo.completed.item")?.[0]
    expect(itemEvent.content).toBe("A")
  })

  it("derives todo.completed.all when every todo is completed", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({
      type: "todo.updated",
      todos: [
        { id: "1", content: "A", status: "pending" },
        { id: "2", content: "B", status: "pending" },
      ],
    })
    await d.onEvent({
      type: "todo.updated",
      todos: [
        { id: "1", content: "A", status: "completed" },
        { id: "2", content: "B", status: "completed" },
      ],
    })
    const types = handle.mock.calls.map(([e]) => e.type)
    expect(types).toContain("todo.completed.all")
  })

  it("does not re-fire todo.completed.all when no new transitions happened", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    const todos = [{ id: "1", content: "A", status: "completed" }]
    await d.onEvent({ type: "todo.updated", todos })
    handle.mockClear()
    await d.onEvent({ type: "todo.updated", todos })
    expect(handle.mock.calls.find(([e]) => e.type === "todo.completed.all")).toBeUndefined()
  })

  it("accumulates assistant text for getContext()", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({
      type: "message.part.updated",
      properties: { part: { id: "p1", type: "text", text: "assistant says hello" } },
    })
    await d.onEvent({
      type: "tool.execute.before",
      properties: { tool: "bash" },
    })
    expect(d.getContext().assistantText).toContain("assistant says hello")
    expect(d.getContext().recentTools).toContain("bash")
  })

  it("never throws when handler throws", async () => {
    const handle = vi.fn().mockRejectedValue(new Error("boom"))
    const push = vi.fn()
    const d = createDispatcher({
      handler: { handle },
      queue: { push },
      onError: () => {},
    } as any)
    await expect(d.onEvent({ type: "session.idle" })).resolves.toBeUndefined()
  })

  it("unwraps OpenCode's { properties } envelope and flattens fields", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({
      type: "tool.execute.before",
      properties: { tool: "bash", sessionID: "s1" },
    })
    const forwarded = handle.mock.calls.find(
      ([e]) => e.type === "tool.execute.before",
    )?.[0]
    expect(forwarded.tool).toBe("bash")
    expect(forwarded.sessionID).toBe("s1")
    // Tool name should also have been tracked in narrator context.
    expect(d.getContext().recentTools).toContain("bash")
  })

  it("does not let properties.type override the event envelope type", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)

    await d.onEvent({
      type: "tool.execute.before",
      properties: { type: "session.error", tool: "bash" },
    })

    const forwarded = handle.mock.calls.find(([e]) => e.tool === "bash")?.[0]
    expect(forwarded.type).toBe("tool.execute.before")
  })

  it("emits message.reasoning.delta sentence-by-sentence from streaming parts", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)

    // Three streaming updates of the same reasoning part. Same part.id, text
    // keeps growing. The dispatcher should only narrate complete sentences,
    // buffering the trailing fragment.
    await d.onEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", type: "reasoning", text: "Let me think about " },
      },
    })
    await d.onEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "p1", type: "reasoning", text: "Let me think about this. Now I'll" },
      },
    })
    await d.onEvent({
      type: "message.part.updated",
      properties: {
        part: {
          id: "p1",
          type: "reasoning",
          text: "Let me think about this. Now I'll write the code.",
        },
      },
    })

    const reasoningCalls = handle.mock.calls
      .map(([e]) => e)
      .filter((e) => e.type === "message.reasoning.delta")
    expect(reasoningCalls.map((e) => e.text)).toEqual([
      "Let me think about this.",
      "Now I'll write the code.",
    ])
    // Each delta gets a unique dedupKey so they queue independently.
    const keys = reasoningCalls.map((e) => e.dedupKey)
    expect(new Set(keys).size).toBe(keys.length)
    expect(reasoningCalls.every((e) => e.partID === "p1")).toBe(true)
  })

  it("force-flushes a reasoning fragment that grows past the flush threshold", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({
      handler: { handle },
      queue: { push },
      reasoningFlushChars: 40,
    } as any)
    // Long fragment with no sentence boundary at all.
    const text = "a".repeat(80)
    await d.onEvent({
      type: "message.part.updated",
      properties: { part: { id: "p2", type: "reasoning", text } },
    })
    const calls = handle.mock.calls
      .map(([e]) => e)
      .filter((e) => e.type === "message.reasoning.delta")
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].text).toContain("a")
  })

  it("emits message.text.delta for streaming assistant text parts", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({
      type: "message.part.updated",
      properties: { part: { id: "t1", type: "text", text: "Hello, " } },
    })
    await d.onEvent({
      type: "message.part.updated",
      properties: { part: { id: "t1", type: "text", text: "Hello, world!" } },
    })
    const deltas = handle.mock.calls
      .map(([e]) => e)
      .filter((e) => e.type === "message.text.delta")
      .map((e) => e.text)
    expect(deltas).toEqual(["Hello, ", "world!"])
    // Text deltas also feed the narrator's assistantText context.
    expect(d.getContext().assistantText).toContain("Hello,")
    expect(d.getContext().assistantText).toContain("world!")
  })

  it("ignores non-text/non-reasoning part types", async () => {
    const handle = vi.fn().mockResolvedValue(null)
    const push = vi.fn()
    const d = createDispatcher({ handler: { handle }, queue: { push } } as any)
    await d.onEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "t1", type: "step-start" },
      },
    })
    const types = handle.mock.calls.map(([e]) => e.type)
    expect(types).not.toContain("message.text.delta")
    expect(types).not.toContain("message.reasoning.delta")
  })
})

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
