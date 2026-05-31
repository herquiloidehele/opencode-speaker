import { generateText, type LanguageModel } from "ai"
import { truncate } from "./template.js"
import type { Logger } from "../log.js"

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

function buildPrompt(
  event: { type: string },
  ctx: NarrationContext,
): string {
  const text = truncate(ctx.assistantText, 2000)
  const tools =
    ctx.recentTools.slice(-5).map((t) => `- ${t}`).join("\n") || "(none)"
  const occasion =
    event.type === "todo.completed.all"
      ? "just completed all todos"
      : "just finished a turn"
  return [
    "You are working as a coding agent, and your output is read aloud by a TTS engine.",
    `I ${occasion}. Explain what I actually did so the user can keep their eyes off the screen:`,
    "- what I attempted, what tools I used, what I changed, and the outcome,",
    "- any blockers, errors, or decisions that need the user's attention,",
    "- next steps if obvious.",
    "",
    "Style rules:",
    "- Speak in first person as the one doing the coding work.",
    "- Use I, me, and my.",
    "- Do not describe yourself in third person.",
    "- spoken English only — no markdown, no code blocks, no quotes, no bullet points,",
    "- plain prose, conversational natural sentences, no filler or restatement of these instructions,",
    "- be concise: every sentence must add information, but do not omit anything the user needs to know,",
    "- skip greetings, sign-offs, and meta commentary about being an AI.",
    "",
    "Recent output from me:",
    text || "(none)",
    "",
    "Recent tool calls I made:",
    tools,
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

      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), config.timeoutMs)
      try {
        const { text } = await generateText({
          model,
          temperature: 0.3,
          prompt: buildPrompt(event, ctx),
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
