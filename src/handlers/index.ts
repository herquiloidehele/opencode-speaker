import { randomUUID } from "node:crypto"
import { Priority, type SpeechRequest } from "../queue/types.js"
import { renderTemplate, stripMarkdown, truncate } from "./template.js"
import type { Narrator, NarrationContext } from "./narrator.js"
import { queuePriorityForEvent } from "../events/catalog.js"

export interface EventConfig {
  enabled: boolean
  mode: "template" | "narrate" | "verbatim"
  priority?: "urgent" | "normal" | "chatty"
}

export interface HandlerRegistryOptions {
  events: Record<string, EventConfig>
  narrator: Narrator
  getContext: () => NarrationContext
}

export interface HandlerRegistry {
  handle(event: { type: string; [k: string]: unknown }): Promise<SpeechRequest | null>
}

type RenderMode = EventConfig["mode"]
type RenderContext = Pick<HandlerRegistryOptions, "narrator" | "getContext">
type ModeRenderer = (
  event: { type: string; [k: string]: unknown },
  ctx: RenderContext,
) => Promise<string | null> | string | null

const MODE_RENDERERS: Record<RenderMode, ModeRenderer> = {
  template: (event) => renderTemplate(event),
  narrate: async (event, ctx) => {
    const text = await ctx.narrator.summarize(event, ctx.getContext())
    return text ?? renderTemplate(event)
  },
  verbatim: (event) => truncate(stripMarkdown(String(event.text ?? "")), 300),
}

function priorityFromName(name?: string): Priority | null {
  if (name === "urgent") return Priority.URGENT
  if (name === "normal") return Priority.NORMAL
  if (name === "chatty") return Priority.CHATTY
  return null
}

export function createHandlerRegistry(opts: HandlerRegistryOptions): HandlerRegistry {
  return {
    async handle(event) {
      const cfg = opts.events[event.type]
      if (!cfg || !cfg.enabled) return null

      const text = await MODE_RENDERERS[cfg.mode](event, opts)
      if (!text) return null

      const priority =
        priorityFromName(cfg.priority) ??
        queuePriorityForEvent(event.type)
      const overrideKey = (event as Record<string, unknown>).dedupKey
      const dedupKey = typeof overrideKey === "string" ? overrideKey : event.type
      return {
        id: randomUUID(),
        priority,
        text,
        dedupKey,
        enqueuedAt: Date.now(),
      }
    },
  }
}
