import { generateText, type LanguageModel } from "ai"
import { truncate } from "./template.js"
import type { Logger } from "../log.js"
import { EVENT_SPECS, type EventSpec, type EventType } from "../events/catalog.js"

export interface NarrationContext {
  assistantText: string
  recentTools: string[]
}

export interface NarratorConfig {
  timeoutMs: number
  minIntervalMs: number
}

export interface Narrator {
  summarize(
    event: { type: string; [k: string]: unknown },
    ctx: NarrationContext,
  ): Promise<string | null>
}

// Stable instructions. Kept separate from the per-event context so the model
// treats the context as data (not instructions) and so this block can be
// prompt-cached. Written in a single voice: the model *is* the agent.
const SYSTEM_PROMPT = [
  "You are the coding agent. Your words are read aloud by a text-to-speech engine while the",
  "user looks away from the screen, so speak as yourself in natural spoken English.",
  "",
  "happened: what you attempted and changed, the outcome, and any blocker, error, or decision",
  "that needs the user's attention. Add an obvious next step only if there is one.",
  "",
  "Style:",
  "- First person — I, me, my. You did the work; never describe yourself in third person or as an AI.",
  "- Plain prose only: no markdown, code blocks, quotes, bullet points, or headings.",
  "- Refer to code by purpose (\"the auth module\", \"the new check\") rather than identifier.",
  "  When a specific file name or the exact error message is the key fact, say it plainly.",
  "- Avoid file paths, type names, and command flags unless one of them is the point.",
  "- Only describe what the context below shows. Do not invent files, tools, or outcomes.",
  "- No greetings, sign-offs, or restating these instructions.",
  "",
  "Example: \"I refactored the credentials loader and its tests pass. No blockers.\"",
].join("\n")

// Normalized fields worth surfacing to the model. These names are produced by
// src/events/normalize.ts, so they're reliable when present.
const FACT_FIELDS = ["tool", "file", "command", "message", "errorName", "content"] as const

function eventFacts(event: { type: string; [k: string]: unknown }): string {
  const lines: string[] = []
  for (const key of FACT_FIELDS) {
    const value = event[key]
    if (typeof value === "string" && value.trim().length > 0) {
      lines.push(`- ${key}: ${truncate(value, 200)}`)
    }
  }
  if (typeof event.count === "number") lines.push(`- count: ${event.count}`)
  return lines.join("\n")
}

function buildContext(
  event: { type: string; [k: string]: unknown },
  ctx: NarrationContext,
): string {
  // The dispatcher already bounds assistantText to its textWindow (4000), but
  // the narrator can be called directly (tests, demo scripts), so cap here too.
  const text = truncate(ctx.assistantText, 10000)
  const tools =
    ctx.recentTools.slice(-5).map((t) => `- ${t}`).join("\n") || "(none)"
  const occasion =
    (EVENT_SPECS[event.type as EventType] as EventSpec | undefined)?.narrationOccasion ??
    "I just finished a turn."
  return [
    occasion,
    "",
    "What I produced recently:",
    text || "(none)",
    "",
    "Tools I recently used:",
    tools,
    "",
    "Event details:",
    eventFacts(event) || "(no extra detail)",
  ].join("\n")
}

export function createNarrator(
  model: LanguageModel,
  config: NarratorConfig,
  logger?: Logger,
): Narrator {
  let lastFinishedAt = 0

  return {
    async summarize(event, ctx) {
      const now = Date.now()
      if (now - lastFinishedAt < config.minIntervalMs) return null

      // Nothing concrete to summarize — skip the LLM call (and don't advance
      // the throttle) so we never speak invented filler. The narrate renderer
      // in handlers/index.ts falls back to the event template in this case.
      const hasContext =
        ctx.assistantText.trim().length > 0 ||
        ctx.recentTools.length > 0 ||
        eventFacts(event).length > 0
      if (!hasContext) return null

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), config.timeoutMs)
      try {
        const { text } = await generateText({
          model,
          system: SYSTEM_PROMPT,
          temperature: 0.2,
          prompt: buildContext(event, ctx),
          abortSignal: ac.signal,
        })
        const trimmed = text.trim()
        if (trimmed.length === 0) return null
        lastFinishedAt = Date.now()
        return trimmed
      } catch (err) {
        if (logger) {
          await logger.warn("narrator summary failed", {
            error: err,
            operation: "summarizing event for narration",
            input: {
              eventType: event.type,
              assistantTextLen: ctx.assistantText.length,
              recentToolsCount: ctx.recentTools.length,
            },
          })
        }
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
