import { describe, it, expect, vi, beforeEach } from "vitest"
import { SpeechQueue } from "../src/queue/speech-queue.js"
import { Priority, type SpeechRequest } from "../src/queue/types.js"

type CallLog = string[]

function makeSpeaker(log: CallLog, delayMs = 10) {
  return async (req: SpeechRequest, signal: AbortSignal): Promise<void> => {
    log.push(`start:${req.id}`)
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        log.push(`done:${req.id}`)
        resolve()
      }, delayMs)
      signal.addEventListener("abort", () => {
        clearTimeout(t)
        log.push(`abort:${req.id}`)
        reject(new DOMException("aborted", "AbortError"))
      })
    })
  }
}

const req = (over: Partial<SpeechRequest>): SpeechRequest => ({
  id: "x",
  priority: Priority.NORMAL,
  text: "hi",
  enqueuedAt: Date.now(),
  ...over,
})

describe("SpeechQueue", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("speaks a single pushed request", async () => {
    const log: CallLog = []
    const q = new SpeechQueue({ speak: makeSpeaker(log), staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "a" }))
    await q.idle()
    expect(log).toEqual(["start:a", "done:a"])
  })

  it("queues a second request behind the first (FIFO at same priority)", async () => {
    const log: CallLog = []
    const q = new SpeechQueue({ speak: makeSpeaker(log), staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "a" }))
    q.push(req({ id: "b" }))
    await q.idle()
    expect(log).toEqual(["start:a", "done:a", "start:b", "done:b"])
  })

  it("higher priority interrupts the currently speaking lower-priority request", async () => {
    const log: CallLog = []
    const q = new SpeechQueue({ speak: makeSpeaker(log, 50), staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "low", priority: Priority.CHATTY }))
    await new Promise((r) => setTimeout(r, 5)) // let "low" start
    q.push(req({ id: "urgent", priority: Priority.URGENT }))
    await q.idle()
    expect(log[0]).toBe("start:low")
    expect(log).toContain("abort:low")
    expect(log).toContain("start:urgent")
    expect(log[log.length - 1]).toBe("done:urgent")
  })

  it("dedupes queued requests by dedupKey, keeping the newest text", async () => {
    const speakLog: string[] = []
    const speak = async (r: SpeechRequest) => {
      speakLog.push(`${r.id}:${r.text}`)
    }
    const q = new SpeechQueue({ speak, staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "block", priority: Priority.URGENT, text: "blocker" }))
    q.push(req({ id: "v1", text: "first", dedupKey: "tool.execute.before", priority: Priority.CHATTY }))
    q.push(req({ id: "v2", text: "second", dedupKey: "tool.execute.before", priority: Priority.CHATTY }))
    q.push(req({ id: "v3", text: "third", dedupKey: "tool.execute.before", priority: Priority.CHATTY }))
    await q.idle()
    expect(speakLog).toEqual(["block:blocker", "v3:third"])
  })

  it("never dedupes the currently speaking request", async () => {
    const log: CallLog = []
    const q = new SpeechQueue({ speak: makeSpeaker(log, 30), staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "current", dedupKey: "k" }))
    await new Promise((r) => setTimeout(r, 5))
    q.push(req({ id: "next", dedupKey: "k" }))
    await q.idle()
    expect(log).toEqual(["start:current", "done:current", "start:next", "done:next"])
  })

  it("drops stale items before speaking them", async () => {
    const speakLog: string[] = []
    const speak = async (r: SpeechRequest) => {
      speakLog.push(r.id)
    }
    let t = 1000
    const q = new SpeechQueue({ speak, staleMs: 100, now: () => t })
    q.push(req({ id: "blocker", priority: Priority.URGENT, enqueuedAt: t }))
    q.push(req({ id: "stale", priority: Priority.CHATTY, enqueuedAt: t }))
    q.push(req({ id: "fresh", priority: Priority.CHATTY, enqueuedAt: t }))
    // Advance time past staleMs before queue gets to chatty items.
    t = 2000
    await q.idle()
    expect(speakLog).toEqual(["blocker"]) // both chatty items dropped as stale at dequeue time
  })

  it("mute drops queue and aborts current", async () => {
    const log: CallLog = []
    const q = new SpeechQueue({ speak: makeSpeaker(log, 50), staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "a" }))
    q.push(req({ id: "b" }))
    await new Promise((r) => setTimeout(r, 5))
    q.mute()
    await q.idle()
    expect(log).toContain("abort:a")
    expect(log).not.toContain("start:b")
    expect(q.size()).toBe(0)
  })

  it("unmute does not re-speak missed events", async () => {
    const log: CallLog = []
    const q = new SpeechQueue({ speak: makeSpeaker(log), staleMs: 8000, now: () => Date.now() })
    q.mute()
    q.push(req({ id: "muted" }))
    q.unmute()
    await q.idle()
    expect(log).toEqual([])
  })

  it("stop interrupts current + clears queue without muting", async () => {
    const log: CallLog = []
    const q = new SpeechQueue({ speak: makeSpeaker(log, 50), staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "a" }))
    q.push(req({ id: "b" }))
    await new Promise((r) => setTimeout(r, 5))
    q.stop()
    await q.idle()
    expect(log).toContain("abort:a")
    expect(log).not.toContain("start:b")
    expect(q.isMuted()).toBe(false)
    // After stop, new requests still speak (proves we didn't mute).
    q.push(req({ id: "c" }))
    await q.idle()
    expect(log).toContain("start:c")
    expect(log).toContain("done:c")
  })

  it("never throws when speak rejects", async () => {
    const speak = async () => {
      throw new Error("synth failed")
    }
    const q = new SpeechQueue({ speak, staleMs: 8000, now: () => Date.now() })
    q.push(req({ id: "broken" }))
    await expect(q.idle()).resolves.toBeUndefined()
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

describe("speech-queue logger injection", () => {
  it("logs speak failures with text preview + voice + priority context", async () => {
    const { logger, warns } = fakeLogger()
    const speak = vi.fn().mockRejectedValue(new Error("synth boom"))
    const onError = vi.fn()
    const q = new SpeechQueue({
      speak,
      staleMs: 60_000,
      now: () => 0,
      onError,
      logger,
    } as any)
    q.push({
      id: "1",
      priority: 2,
      text: "Hello world this is a test sentence about logging",
      enqueuedAt: 0,
    } as any)
    await q.idle()
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toBe("speak failed")
    expect(warns[0].ctx.error).toBeInstanceOf(Error)
    expect(warns[0].ctx.operation).toBe("synthesizing queued speech")
    expect(warns[0].ctx.input.textPreview).toMatch(/^Hello world/)
    expect(warns[0].ctx.input.priority).toBe(2)
    expect(onError).toHaveBeenCalled()
  })
})
