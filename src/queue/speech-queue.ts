import { Priority, type SpeechRequest } from "./types.js"
import type { Logger } from "../log.js"

export type SpeakFn = (req: SpeechRequest, signal: AbortSignal) => Promise<void>

export interface SpeechQueueOptions {
  speak: SpeakFn
  staleMs: number
  now: () => number
  onError?: (err: unknown, req: SpeechRequest) => void
  logger?: Logger
}

export class SpeechQueue {
  private queue: SpeechRequest[] = []
  private current: { req: SpeechRequest; abort: AbortController } | null = null
  private muted = false
  private idleResolvers: Array<() => void> = []
  private pumpRunning = false

  constructor(private readonly opts: SpeechQueueOptions) {}

  push(req: SpeechRequest): void {
    if (this.muted) return

    // Rule 2: interrupt if higher priority than current.
    if (this.current && req.priority > this.current.req.priority) {
      this.queue.unshift(req)
      this.current.abort.abort()
      return
    }

    // Rule 3: dedup by key against queued (not current) items.
    if (req.dedupKey) {
      const idx = this.queue.findIndex((q) => q.dedupKey === req.dedupKey)
      if (idx >= 0) {
        this.queue[idx] = req // newer wins
        return
      }
    }

    // Rule 4: insert by priority (stable FIFO within priority).
    let i = 0
    while (i < this.queue.length && this.queue[i].priority >= req.priority) i++
    this.queue.splice(i, 0, req)

    void this.pump()
  }

  mute(): void {
    this.muted = true
    this.queue = []
    if (this.current) this.current.abort.abort()
  }

  unmute(): void {
    this.muted = false
  }

  /**
   * Interrupt the current utterance and drop the pending queue WITHOUT
   * changing the muted state. Use this for "stop speaking right now" while
   * leaving future events free to speak.
   */
  stop(): void {
    this.queue = []
    if (this.current) this.current.abort.abort()
  }

  isMuted(): boolean {
    return this.muted
  }

  size(): number {
    return this.queue.length + (this.current ? 1 : 0)
  }

  /** Resolves when queue is empty and nothing is speaking. */
  async idle(): Promise<void> {
    if (!this.current && this.queue.length === 0 && !this.pumpRunning) return
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve)
    })
  }

  private async pump(): Promise<void> {
    if (this.pumpRunning || this.current) return
    this.pumpRunning = true
    try {
      while (this.queue.length > 0 && !this.muted) {
        const next = this.queue.shift()!
        // Rule 5: stale drop for non-urgent items.
        if (
          next.priority <= Priority.NORMAL &&
          this.opts.now() - next.enqueuedAt > this.opts.staleMs
        ) {
          continue
        }
        const abort = new AbortController()
        this.current = { req: next, abort }
        try {
          await this.opts.speak(next, abort.signal)
        } catch (err) {
          if (this.opts.logger) {
            await this.opts.logger.warn("speak failed", {
              error: err,
              operation: "synthesizing queued speech",
              input: {
                textPreview: next.text.slice(0, 80),
                priority: next.priority,
                enqueuedAt: next.enqueuedAt,
              },
            })
          }
          this.opts.onError?.(err, next)
        } finally {
          this.current = null
        }
      }
    } finally {
      this.pumpRunning = false
      if (!this.current && this.queue.length === 0) {
        const resolvers = this.idleResolvers
        this.idleResolvers = []
        for (const r of resolvers) r()
      }
    }
  }
}
