import { describe, it, expect, vi } from "vitest"
import { createCommands } from "../src/commands/index.js"
import { Priority } from "../src/queue/types.js"

function fakeQueue() {
  const log: string[] = []
  let muted = false
  return {
    log,
    push: vi.fn((r: any) => log.push(`push:${r.text}`)),
    mute: vi.fn(() => { muted = true; log.push("mute") }),
    unmute: vi.fn(() => { muted = false; log.push("unmute") }),
    stop: vi.fn(() => log.push("stop")),
    size: vi.fn(() => 3),
    isMuted: vi.fn(() => muted),
  } as any
}

describe("commands", () => {
  it("mute calls queue.mute and updates state", () => {
    const q = fakeQueue()
    const c = createCommands({ queue: q, providerName: "openai", voiceName: "X" })
    c.mute()
    expect(q.mute).toHaveBeenCalled()
    expect(c.status().muted).toBe(true)
  })

  it("unmute calls queue.unmute and updates state", () => {
    const q = fakeQueue()
    const c = createCommands({ queue: q, providerName: "openai", voiceName: "X" })
    c.mute()
    c.unmute()
    expect(q.unmute).toHaveBeenCalled()
    expect(c.status().muted).toBe(false)
  })

  it("say pushes a NORMAL-priority request", () => {
    const q = fakeQueue()
    const c = createCommands({ queue: q, providerName: "openai", voiceName: "X" })
    c.say("hello there")
    const req = q.push.mock.calls[0][0]
    expect(req.text).toBe("hello there")
    expect(req.priority).toBe(Priority.NORMAL)
  })

  it("test pushes a canned message", () => {
    const q = fakeQueue()
    const c = createCommands({ queue: q, providerName: "openai", voiceName: "X" })
    c.test()
    expect(q.push).toHaveBeenCalled()
  })

  it("stop calls queue.stop but leaves mute state alone", () => {
    const q = fakeQueue()
    const c = createCommands({ queue: q, providerName: "openai", voiceName: "X" })
    c.stop()
    expect(q.stop).toHaveBeenCalled()
    expect(q.mute).not.toHaveBeenCalled()
    expect(c.status().muted).toBe(false)
  })

  it("toggle flips mute state and returns the new value", () => {
    const q = fakeQueue()
    const c = createCommands({ queue: q, providerName: "openai", voiceName: "X" })
    expect(c.toggle()).toBe(true)
    expect(q.mute).toHaveBeenCalledTimes(1)
    expect(c.status().muted).toBe(true)
    expect(c.toggle()).toBe(false)
    expect(q.unmute).toHaveBeenCalledTimes(1)
    expect(c.status().muted).toBe(false)
  })

  it("status returns provider/voice/muted/queue size", () => {
    const q = fakeQueue()
    const c = createCommands({ queue: q, providerName: "openai", voiceName: "nova" })
    const s = c.status()
    expect(s.provider).toBe("openai")
    expect(s.voice).toBe("nova")
    expect(s.queueSize).toBe(3)
    expect(s.muted).toBe(false)
  })

  it("reports mute state from the queue", () => {
    let muted = true
    const q = {
      push: vi.fn(),
      mute: vi.fn(() => { muted = true }),
      unmute: vi.fn(() => { muted = false }),
      stop: vi.fn(),
      size: vi.fn(() => 0),
      isMuted: vi.fn(() => muted),
    }
    const c = createCommands({ queue: q, providerName: "openai" })

    expect(c.status().muted).toBe(true)
    c.unmute()
    expect(c.status().muted).toBe(false)
  })
})
