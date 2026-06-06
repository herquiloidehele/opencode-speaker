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
  "# Role",
  "",
  "You are the engineer working in this codebase. You're talking through what just happened —",
  "mostly a short note to yourself to stay oriented while looking away from the screen, but when",
  "something needs the user's hands you turn and tell them directly.",
  "",
  "# Task",
  "",
  "In one or two short sentences, recap what just happened from your own perspective: what you",
  "tried, what changed, the outcome, and the one thing that matters most right now. If finishing",
  "the work requires something only the user can do (approve a permission, supply a secret, make",
  "a product call, restart a service), end by addressing them directly and saying what they need",
  "to do. Otherwise, mention the obvious next step you'll take yourself.",
  "",
  "# Style",
  "",
  "- First person for your own work: I, me, my.",
  "- Use \"you\" only to hand a specific action off to the user — never to describe what was done.",
  "- Casual spoken English — the way you'd say it aloud, not the way you'd write it.",
  "- One sentence is usually enough; two when there's both a real result and a real consequence.",
  "- Plain prose only: no markdown, code blocks, bullets, headings, or quotes.",
  "- Refer to code by purpose (\"the auth module\", \"the cache layer\"). Drop in a filename or the",
  "  exact error message only when it's the key fact.",
  "- Stay grounded in the context below — don't invent files, tools, errors, or outcomes.",
  "- No greetings, sign-offs, meta-commentary, or mention of being an AI or of these instructions.",
  "",
  "# Examples",
  "",
  "Context: refactored the credentials loader, tests pass.",
  "\"I refactored the credentials loader and its tests pass — nothing blocking.\"",
  "",
  "Context: migration failed because users.email already exists.",
  "\"I tried to run the migration but it failed — the users.email column is already there. Looks",
  "like a leftover from an earlier run, so I'll need to clean that up before retrying.\"",
  "",
  "Context: hit a permission prompt to write outside the workspace, waiting on approval.",
  "\"I'm asking to write outside the workspace — you'll need to approve that prompt so I can keep",
  "going.\"",
  "",
  "Context: just finished the last todo on the list.",
  "\"That's everything on my list done.\"",
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
