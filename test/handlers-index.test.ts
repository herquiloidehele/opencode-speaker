import { describe, it, expect, vi } from "vitest"
import { createHandlerRegistry } from "../src/handlers/index.js"
import { Priority } from "../src/queue/types.js"

const baseEvents = {
  "session.idle":         { enabled: true, mode: "narrate"  as const },
  "session.error":        { enabled: true, mode: "template" as const, priority: "urgent" as const },
  "tool.execute.before":  { enabled: true, mode: "template" as const },
  "message.updated":      { enabled: true, mode: "verbatim" as const },
  "disabled.event":       { enabled: false, mode: "template" as const },
}

function fakeNarrator(text: string | null) {
  return { summarize: vi.fn().mockResolvedValue(text) }
}

describe("handler registry", () => {
  it("returns null for disabled events", async () => {
    const r = createHandlerRegistry({
      events: baseEvents,
      narrator: fakeNarrator("hi"),
      getContext: () => ({ assistantText: "", recentTools: [] }),
    })
    expect(await r.handle({ type: "disabled.event" })).toBeNull()
  })

  it("uses template for mode=template", async () => {
    const r = createHandlerRegistry({
      events: baseEvents,
      narrator: fakeNarrator(null),
      getContext: () => ({ assistantText: "", recentTools: [] }),
    })
    const sr = await r.handle({ type: "session.error", message: "bad" })
    expect(sr?.text).toContain("I hit a session error")
    expect(sr?.priority).toBe(Priority.URGENT)
    expect(sr?.dedupKey).toBe("session.error")
  })

  it("uses narrator for mode=narrate", async () => {
    const n = fakeNarrator("Wrapped up.")
    const r = createHandlerRegistry({
      events: baseEvents,
      narrator: n,
      getContext: () => ({ assistantText: "did x", recentTools: [] }),
    })
    const sr = await r.handle({ type: "session.idle" })
    expect(n.summarize).toHaveBeenCalled()
    expect(sr?.text).toBe("Wrapped up.")
    expect(sr?.priority).toBe(Priority.NORMAL)
  })

  it("falls back to template when narrator returns null", async () => {
    const r = createHandlerRegistry({
      events: baseEvents,
      narrator: fakeNarrator(null),
      getContext: () => ({ assistantText: "x", recentTools: [] }),
    })
    const sr = await r.handle({ type: "session.idle" })
    expect(sr?.text).toBe("I'm idle now and waiting for your next instruction.")
  })

  it("returns null when template has no entry and narrator returns null", async () => {
    const r = createHandlerRegistry({
      events: { "unknown.thing": { enabled: true, mode: "narrate" as const } },
      narrator: fakeNarrator(null),
      getContext: () => ({ assistantText: "", recentTools: [] }),
    })
    expect(await r.handle({ type: "unknown.thing" })).toBeNull()
  })

  it("uses verbatim mode (read text field)", async () => {
    const r = createHandlerRegistry({
      events: baseEvents,
      narrator: fakeNarrator(null),
      getContext: () => ({ assistantText: "", recentTools: [] }),
    })
    const sr = await r.handle({ type: "message.updated", text: "**hello world**" })
    expect(sr?.text).toBe("hello world")
  })

  it("applies CHATTY priority to tool events by default", async () => {
    const r = createHandlerRegistry({
      events: baseEvents,
      narrator: fakeNarrator(null),
      getContext: () => ({ assistantText: "", recentTools: [] }),
    })
    const sr = await r.handle({ type: "tool.execute.before", tool: "bash" })
    expect(sr?.priority).toBe(Priority.CHATTY)
  })

  it("uses canonical priority when event config omits priority", async () => {
    const r = createHandlerRegistry({
      events: { "permission.asked": { enabled: true, mode: "template" as const } },
      narrator: fakeNarrator(null),
      getContext: () => ({ assistantText: "", recentTools: [] }),
    })

    const req = await r.handle({ type: "permission.asked", tool: "bash" })
    expect(req?.priority).toBe(Priority.URGENT)
  })

  it("honors a per-event dedupKey override (used by streaming deltas)", async () => {
    const r = createHandlerRegistry({
      events: {
        "message.reasoning.delta": { enabled: true, mode: "verbatim" as const },
      },
      narrator: fakeNarrator(null),
      getContext: () => ({ assistantText: "", recentTools: [] }),
    })
    const sr1 = await r.handle({
      type: "message.reasoning.delta",
      text: "first sentence",
      dedupKey: "message.reasoning.delta:p1:1",
    })
    const sr2 = await r.handle({
      type: "message.reasoning.delta",
      text: "second sentence",
      dedupKey: "message.reasoning.delta:p1:2",
    })
    expect(sr1?.dedupKey).toBe("message.reasoning.delta:p1:1")
    expect(sr2?.dedupKey).toBe("message.reasoning.delta:p1:2")
    expect(sr1?.dedupKey).not.toBe(sr2?.dedupKey)
  })
})
