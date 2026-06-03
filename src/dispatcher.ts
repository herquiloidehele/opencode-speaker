import type { SpeechRequest } from "./queue/types.js"
import type { HandlerRegistry } from "./handlers/index.js"
import type { NarrationContext } from "./handlers/narrator.js"
import type { Logger } from "./log.js"
import { normalizeEvent, type RawEvent } from "./events/normalize.js"

interface QueueIfc {
  push(req: SpeechRequest): void
}

export interface DispatcherOptions {
  handler: HandlerRegistry
  queue: QueueIfc
  logger?: Logger
  onError?: (err: unknown, event: { type: string }) => void
  /** Max chars of recent assistant text to keep. */
  textWindow?: number
  /** Max recent tool calls to remember. */
  toolWindow?: number
  /** Max chars of reasoning buffer before forced flush when no sentence end is found. */
  reasoningFlushChars?: number
  /** Clock source (injectable for tests). Defaults to Date.now. */
  now?: () => number
  /**
   * How long after a `permission.replied` to keep muting reasoning/text
   * narration, so a thought that streams just after the reply doesn't speak
   * on top of the permission template. Defaults to 2000ms.
   */
  permissionMuteTailMs?: number
}

interface TodoSnapshot {
  id: string
  content: string
  status: string
}

interface PartLike {
  id?: string
  type?: string
  text?: string
  [k: string]: unknown
}

export interface Dispatcher {
  onEvent(event: RawEvent): Promise<void>
  getContext(): NarrationContext
}

// Matches a sentence ending with . ! or ? optionally followed by a closing
// quote/bracket and either whitespace or end-of-string. The lookahead-free
// form keeps the regex compatible with older engines and easy to reason about.
const SENTENCE_RE = /[\s\S]*?[.!?]+(?:["')\]]?)(?:\s+|$)/g

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  const textWindow = opts.textWindow ?? 4000
  const toolWindow = opts.toolWindow ?? 10
  const reasoningFlushChars = opts.reasoningFlushChars ?? 240
  const now = opts.now ?? (() => Date.now())
  const permissionMuteTailMs = opts.permissionMuteTailMs ?? 2000

  let assistantText = ""
  const recentTools: string[] = []
  // v2 `session.next.tool.success`/`.failed` only carry `callID`, not the
  // tool name. We remember the callID -> tool mapping when the matching
  // `tool.execute.before` (normalized from `session.next.tool.called`) fires
  // so the after-event template can still say "I finished running X."
  const toolByCallId = new Map<string, string>()
  const todoStatus = new Map<string, string>() // id -> last seen status

  // For streaming message parts (text + reasoning): how much of each part's
  // text we have already processed. Each `message.part.updated` carries the
  // FULL current state of a part, so the delta is `part.text.slice(seenLen)`.
  const partSeen = new Map<string, number>()
  // True between a `permission.asked` and its `permission.replied`. While set,
  // the agent has paused for the user and opencode fires `session.idle`; the
  // permission template already announced the pause, so we suppress the idle
  // narration (and its turn-state reset) to avoid speaking twice about it.
  let permissionPending = false
  // `permission.replied` only carries `requestID` + `reply` — no friendly
  // name. We remember the name from the matching `permission.asked` (whose
  // `id` equals the reply's `requestID`) so the reply template can say what
  // was actually granted instead of "the operation".
  const permissionNameById = new Map<string, string>()
  // Reasoning/text narration is muted while a permission is pending and for a
  // short tail after the reply, so the agent's spoken thoughts don't double up
  // with the permission template around the same moment. 0 = not muting.
  let permissionMuteUntil = 0
  function permissionMuteActive(): boolean {
    return permissionPending || now() < permissionMuteUntil
  }
  // For reasoning specifically, we buffer trailing text without a sentence
  // boundary so we don't speak half-thoughts like "Let me" / "think about".
  const reasoningBuffer = new Map<string, string>()
  // Monotonic counter so each synthesized streaming delta has its own dedup
  // key — otherwise successive reasoning deltas would collapse against each
  // other in the speech queue and we'd lose content.
  let deltaSequence = 0

  function appendText(t: string) {
    assistantText = (assistantText + " " + t).slice(-textWindow)
  }

  function trackTool(tool: string) {
    recentTools.push(tool)
    while (recentTools.length > toolWindow) recentTools.shift()
  }

  // A "turn" is one user prompt + the agent response that follows it, ended by
  // session.idle. Without this reset, assistantText/recentTools accumulate
  // across every turn in a session, so the narrator's end-of-turn summary
  // would describe everything since the session began instead of just this
  // turn. Must run AFTER session.idle's handler chain so the narrator still
  // sees the full turn's context.
  function resetTurnState() {
    assistantText = ""
    recentTools.length = 0
    partSeen.clear()
    reasoningBuffer.clear()
    toolByCallId.clear()
    permissionPending = false
  }

  async function fire(event: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      const sr = await opts.handler.handle(event)
      if (sr) {
        // DIAGNOSTIC: record every line we actually queue for speech, tagged
        // with the event that produced it. This is how we see a "double" —
        // two queued requests for one logical moment — and which events caused
        // them. Remove once the permission double-speak is understood.
        await opts.logger?.info("queued speech", {
          operation: "queuing speech request",
          input: { eventType: event.type, text: sr.text, dedupKey: sr.dedupKey, priority: sr.priority },
        })
        opts.queue.push(sr)
      }
    } catch (err) {
      if (opts.logger) {
        await opts.logger.warn("handler failed", {
          error: err,
          operation: "dispatching opencode event",
          input: { eventType: event.type },
        })
      }
      opts.onError?.(err, event)
    }
  }

  async function handleTodoUpdated(props: { todos?: TodoSnapshot[] }): Promise<void> {
    const todos = props.todos ?? []
    let transitionsToCompleted = 0
    for (const t of todos) {
      const prev = todoStatus.get(t.id)
      if (prev !== "completed" && t.status === "completed") {
        transitionsToCompleted++
        await fire({ type: "todo.completed.item", content: t.content })
      }
      todoStatus.set(t.id, t.status)
    }
    if (
      todos.length > 0 &&
      todos.every((t) => t.status === "completed") &&
      transitionsToCompleted > 0
    ) {
      await fire({ type: "todo.completed.all", count: todos.length })
    }
    await fire({ type: "todo.updated", todos })
  }

  function computeDelta(partId: string, fullText: string): string | null {
    const prev = partSeen.get(partId) ?? 0
    // Defensive: text shouldn't shrink, but if a stream resets we re-anchor.
    if (fullText.length < prev) {
      partSeen.set(partId, fullText.length)
      return null
    }
    if (fullText.length === prev) return null
    const delta = fullText.slice(prev)
    partSeen.set(partId, fullText.length)
    return delta
  }

  async function handleTextPart(part: PartLike): Promise<void> {
    if (!part.id || typeof part.text !== "string") return
    const delta = computeDelta(part.id, part.text)
    if (!delta) return
    // Update assistant context for the narrator regardless of whether the
    // user has enabled live text narration.
    appendText(delta)
    // Don't speak streamed text on top of a permission template. partSeen has
    // already advanced (via computeDelta), so this text won't replay later.
    if (permissionMuteActive()) return
    await fire({
      type: "message.text.delta",
      text: delta,
      partID: part.id,
      dedupKey: `message.text.delta:${part.id}:${++deltaSequence}`,
    })
  }

  async function handleReasoningPart(part: PartLike): Promise<void> {
    if (!part.id || typeof part.text !== "string") return
    const delta = computeDelta(part.id, part.text)
    if (!delta) return

    // Mute the agent's spoken reasoning around a permission so it doesn't
    // double up with the permission template. partSeen already advanced, and
    // we drop any half-buffered sentence so it can't replay once unmuted.
    if (permissionMuteActive()) {
      reasoningBuffer.delete(part.id)
      return
    }

    let buffered = (reasoningBuffer.get(part.id) ?? "") + delta

    const sentences: string[] = []
    let cursor = 0
    SENTENCE_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SENTENCE_RE.exec(buffered)) !== null) {
      sentences.push(m[0].trim())
      cursor = SENTENCE_RE.lastIndex
    }
    buffered = buffered.slice(cursor)

    // If the trailing fragment grows large without a sentence end, force-flush
    // it so very long reasoning blocks without punctuation still get heard.
    if (buffered.length >= reasoningFlushChars) {
      sentences.push(buffered.trim())
      buffered = ""
    }

    reasoningBuffer.set(part.id, buffered)

    for (const sentence of sentences) {
      if (!sentence) continue
      await fire({
        type: "message.reasoning.delta",
        text: sentence,
        partID: part.id,
        dedupKey: `message.reasoning.delta:${part.id}:${++deltaSequence}`,
      })
    }
  }

  async function handleMessagePart(props: { part?: PartLike }): Promise<void> {
    const part = props.part
    if (!part || typeof part !== "object") return
    if (part.type === "text") {
      await handleTextPart(part)
    } else if (part.type === "reasoning") {
      await handleReasoningPart(part)
    }
    // Other part types (tool, file, step-start, …) are surfaced via their
    // dedicated events; nothing further to forward here.
  }

  return {
    async onEvent(event) {
      const normalized = normalizeEvent(event)

      if (normalized.type === "permission.asked") {
        permissionPending = true
        const pid = normalized.id
        const name = normalized.tool
        if (typeof pid === "string" && typeof name === "string") {
          permissionNameById.set(pid, name)
        }
      } else if (normalized.type === "permission.replied") {
        permissionPending = false
        permissionMuteUntil = now() + permissionMuteTailMs
        // The reply has no name of its own — recover it from the ask.
        if (typeof normalized.tool !== "string") {
          const rid = normalized.requestID
          const name = typeof rid === "string" ? permissionNameById.get(rid) : undefined
          if (name) normalized.tool = name
          if (typeof rid === "string") permissionNameById.delete(rid)
        }
      } else if (normalized.type === "session.idle" && permissionPending) {
        // Paused for a pending permission: the permission template already
        // spoke. Skip the idle narration AND the turn-state reset — the turn
        // resumes once the user replies, so the narrator still needs context.
        return
      }

      if (normalized.type === "todo.updated") {
        const todos = normalized.todos as TodoSnapshot[] | undefined
        return handleTodoUpdated({ todos })
      }

      if (normalized.type === "message.part.updated") {
        const part = normalized.part as PartLike | undefined
        return handleMessagePart({ part })
      }

      if (normalized.type === "tool.execute.before") {
        const tool = normalized.tool as string | undefined
        const callID = normalized.callID as string | undefined
        if (typeof tool === "string") {
          trackTool(tool)
          if (typeof callID === "string") toolByCallId.set(callID, tool)
        }
      } else if (normalized.type === "tool.execute.after") {
        // v2 success/failed events lose the tool name — recover it from the
        // matching `before` event so the template can say "I finished X."
        if (typeof normalized.tool !== "string") {
          const callID = normalized.callID as string | undefined
          const remembered = callID ? toolByCallId.get(callID) : undefined
          if (remembered) normalized.tool = remembered
        }
        const callID = normalized.callID as string | undefined
        if (callID) toolByCallId.delete(callID)
      }

      try {
        await fire(normalized)
      } finally {
        if (
          normalized.type === "session.idle" ||
          normalized.type === "session.created"
        ) {
          resetTurnState()
        }
      }
    },
    getContext() {
      return { assistantText, recentTools: [...recentTools] }
    },
  }
}
