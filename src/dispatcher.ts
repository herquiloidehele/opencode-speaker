import type { SpeechRequest } from "./queue/types.js"
import type { HandlerRegistry } from "./handlers/index.js"
import type { NarrationContext } from "./handlers/narrator.js"
import type { Logger } from "./log.js"

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
  onEvent(event: { type: string; [k: string]: unknown }): Promise<void>
  onMessagePart(text: string): Promise<void>
  onToolStart(tool: string): Promise<void>
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

  let assistantText = ""
  const recentTools: string[] = []
  const todoStatus = new Map<string, string>() // id -> last seen status

  // For streaming message parts (text + reasoning): how much of each part's
  // text we have already processed. Each `message.part.updated` carries the
  // FULL current state of a part, so the delta is `part.text.slice(seenLen)`.
  const partSeen = new Map<string, number>()
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

  async function fire(event: { type: string; [k: string]: unknown }): Promise<void> {
    try {
      const sr = await opts.handler.handle(event)
      if (sr) opts.queue.push(sr)
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
      // OpenCode delivers events as { id, type, properties }. Older paths and
      // some tests pass fields at the top level; merge both so templates can
      // reach `e.tool`, `e.message`, `e.todos`, etc. without caring about the
      // shape.
      const props = ((event as any).properties && typeof (event as any).properties === "object"
        ? (event as any).properties
        : {}) as Record<string, unknown>

      if (event.type === "todo.updated") {
        const todos = (props.todos ?? (event as any).todos) as TodoSnapshot[] | undefined
        return handleTodoUpdated({ todos })
      }

      if (event.type === "message.part.updated") {
        const part = (props.part ?? (event as any).part) as PartLike | undefined
        return handleMessagePart({ part })
      }

      if (event.type === "tool.execute.before") {
        const tool = (props.tool ?? (event as any).tool) as string | undefined
        if (typeof tool === "string") trackTool(tool)
      }

      // Flatten properties into the event so existing templates that read
      // `e.tool`, `e.message`, `e.file`, etc. keep working regardless of the
      // wire shape.
      const forwarded = { ...event, ...props }
      await fire(forwarded)
    },
    async onMessagePart(text) {
      appendText(text)
    },
    async onToolStart(tool) {
      trackTool(tool)
    },
    getContext() {
      return { assistantText, recentTools: [...recentTools] }
    },
  }
}
