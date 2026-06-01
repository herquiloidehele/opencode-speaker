export interface AnyEvent {
  type: string
  [key: string]: unknown
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + "…"
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")          // fenced code
    .replace(/`([^`]+)`/g, "$1")             // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // bold
    .replace(/\*([^*]+)\*/g, "$1")           // italic
    .replace(/__([^_]+)__/g, "$1")           // bold
    .replace(/_([^_]+)_/g, "$1")             // italic
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links
    .replace(/^#+\s+/gm, "")                 // headings
    .replace(/^\s*[-*+]\s+/gm, "")           // list bullets
    .replace(/\s+/g, " ")
    .trim()
}

type Renderer = (e: AnyEvent) => string

function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "")
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return i >= 0 ? trimmed.slice(i + 1) : trimmed
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

const templates: Record<string, Renderer> = {
  // --- Real OpenCode events ---
  "session.idle":         ()  => "I'm idle now and waiting for your next instruction.",
  "session.error":        (e) =>
    `I hit a session error: ${truncate(String(e.message ?? "unknown"), 200)}. Check the log for details.`,
  "session.compacted":    ()  =>
    "I compacted the session, so older context is summarized and I have more room to continue.",
  "session.created":      () => "I'm starting a new session and getting ready to work.",
  "permission.asked":     (e) =>
    `I need your approval before I use ${asString(e.tool) ?? "an operation"}.`,
  "permission.replied":   (e) => {
    const raw = String(e.decision ?? "responded").toLowerCase()
    const verb =
      raw === "allow" || raw === "approve" || raw === "accept" || raw === "yes" ||
      raw === "once" || raw === "always"
        ? "granted"
        : raw === "deny" || raw === "reject" || raw === "no"
          ? "denied"
          : raw
    const tool = asString(e.tool) ?? "the operation"
    if (verb === "granted") return `I got approval to use ${tool}.`
    if (verb === "denied") return `I was denied permission to use ${tool}.`
    if (verb === "responded") return `I got a response for ${tool}.`
    return `I got a permission response for ${tool}: ${verb}.`
  },
  "tool.execute.before":  (e) => `I'm running ${asString(e.tool) ?? "tool"} now.`,
  "tool.execute.after":   (e) => `I finished running ${asString(e.tool) ?? "tool"}.`,
  "file.edited":          (e) => {
    const raw = String(e.file ?? "")
    return raw ? `I edited ${basename(raw)}.` : "I edited a file."
  },
  "command.executed":     (e) => {
    const name = String(e.command ?? "").trim()
    return name ? `I ran ${name}.` : "I ran a command."
  },
  // Note: `message.updated` carries `{ sessionID, info: Message }` — the
  // message text lives in `info.parts`, not at the top level. Live narration
  // is handled by the synthesized `message.text.delta` events derived from
  // `message.part.updated`, so there is intentionally no template here.

  // --- Synthesized by src/dispatcher.ts ---
  "message.text.delta":      (e) => truncate(stripMarkdown(String(e.text ?? "")), 600),
  "message.reasoning.delta": (e) => truncate(stripMarkdown(String(e.text ?? "")), 600),
  "todo.completed.all":   (e) => {
    const n = Number(e.count ?? 0)
    return n > 0
      ? `I've completed all ${n} todos. Nice work.`
      : "I've completed all todos. Nice work."
  },
  "todo.completed.item":  (e) =>
    `I finished this task: ${truncate(stripMarkdown(String(e.content ?? "")), 80)}.`,
}

export function renderTemplate(event: AnyEvent): string | null {
  const fn = templates[event.type]
  if (!fn) return null
  const out = fn(event)
  return out.length === 0 ? null : out
}
