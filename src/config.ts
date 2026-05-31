import { z } from "zod"
import { SLUG_RE } from "./ai-sdk/models.js"

/** Plugin identity. Used as the log scope, tmpdir prefix, and error labels. */
export const PLUGIN_NAME = "opencode-speaker"

/** Default TTS model slug (used by schema + tests + demo scripts). */
export const DEFAULT_TTS_MODEL = "openai/gpt-4o-mini-tts"

/** Default narrator (LLM) model slug. */
export const DEFAULT_NARRATOR_MODEL = "openai/gpt-4.1-mini"

/** Default startup greeting (spoken once when the plugin is ready). */
export const DEFAULT_GREETING = "Welcome to OpenCode Speaker!"

/** Environment variable name: when "1", disables the plugin entirely. */
export const ENV_DISABLED = "OPENCODE_VOICE_DISABLED"

/** Environment variable name: when "1", starts the plugin muted. */
export const ENV_MUTE = "OPENCODE_VOICE_MUTE"

const PrioritySchema = z.enum(["urgent", "normal", "chatty"]).optional()
const ModeSchema = z.enum(["template", "narrate", "verbatim"])

const EventConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mode: ModeSchema.default("template"),
  priority: PrioritySchema,
})

const SLUG_MSG = `must be 'provider/model' (e.g. '${DEFAULT_TTS_MODEL}')`

const TTSSchema = z.object({
  model: z.string().regex(SLUG_RE, `tts.model ${SLUG_MSG}`).default(DEFAULT_TTS_MODEL),
  voice: z.string().optional(),
  rate:  z.number().min(0.5).max(2.0).default(1.0),
  pitch: z.number().min(0.5).max(2.0).default(1.0),
}).default({})

const NarratorSchema = z.object({
  model: z.string().regex(SLUG_RE, `narrator.model ${SLUG_MSG}`).default(DEFAULT_NARRATOR_MODEL),
  timeoutMs:     z.number().int().positive().default(5000),
  minIntervalMs: z.number().int().min(0).default(3000),
}).default({})

const QueueSchema = z.object({
  staleMs: z.number().int().min(0).default(8000),
}).default({})

const EventsSchema = z.record(z.string(), EventConfigSchema).default({})

const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  startMuted: z.boolean().default(false),
  greeting: z.string().default(DEFAULT_GREETING),
  tts: TTSSchema,
  narrator: NarratorSchema,
  events: EventsSchema,
  queue: QueueSchema,
})

export type VoiceConfig = z.infer<typeof VoiceConfigSchema>
export type EventConfig = z.infer<typeof EventConfigSchema>

// Event keys come in two flavors:
//   1. Real OpenCode plugin events as documented at
//      https://opencode.ai/docs/plugins/#events — these are dispatched by
//      opencode itself and reach us via the `event` hook in src/index.ts.
//   2. Plugin-internal synthesized events — fired by src/dispatcher.ts when
//      it derives higher-level signals from raw events. These are NOT in the
//      opencode docs but are valid configuration keys for this plugin.
//      Currently synthesized:
//        - "todo.completed.item" / "todo.completed.all" (from `todo.updated`)
//        - "message.text.delta" / "message.reasoning.delta" (from per-sentence
//          deltas of `message.part.updated` text and reasoning parts).
const DEFAULT_EVENTS: Record<
  string,
  { enabled: boolean; mode: "template" | "narrate" | "verbatim"; priority?: "urgent" | "normal" | "chatty" }
> = {
  // --- Real OpenCode events ---
  "session.idle":         { enabled: true,  mode: "narrate" },
  "session.error":        { enabled: true,  mode: "template", priority: "urgent" },
  "session.compacted":    { enabled: true,  mode: "template" },
  "session.created":      { enabled: true,  mode: "template" },
  "permission.asked":     { enabled: true,  mode: "template", priority: "urgent" },
  "permission.replied":   { enabled: true,  mode: "template" },
  "tool.execute.before":  { enabled: true,  mode: "template" },
  "tool.execute.after":   { enabled: true,  mode: "template" },
  "file.edited":          { enabled: true,  mode: "template" },
  "command.executed":     { enabled: true,  mode: "template" },
  "message.updated":      { enabled: false, mode: "verbatim" },
  "message.reasoning.delta": { enabled: true,  mode: "verbatim", priority: "chatty" },
  "message.text.delta":      { enabled: false, mode: "verbatim", priority: "chatty" },
  "todo.completed.item":     { enabled: true,  mode: "template" },
  "todo.completed.all":      { enabled: true,  mode: "narrate" },
}

export const DEFAULT_CONFIG: VoiceConfig = VoiceConfigSchema.parse({ events: DEFAULT_EVENTS })

export type ParseResult =
  | { ok: true; config: VoiceConfig }
  | { ok: false; errors: { path: string; message: string }[] }

export function parseConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): ParseResult {
  const userObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}

  // Merge raw user input over defaults (event-level deep merge).
  const userEvents =
    userObj.events && typeof userObj.events === "object"
      ? (userObj.events as Record<string, unknown>)
      : {}
  const mergedEvents: Record<string, unknown> = { ...DEFAULT_EVENTS }
  for (const [key, val] of Object.entries(userEvents)) {
    mergedEvents[key] = { ...(DEFAULT_EVENTS[key] ?? {}), ...(val as object) }
  }

  const merged = { ...userObj, events: mergedEvents }
  const parsed = VoiceConfigSchema.safeParse(merged)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    }
  }
  const cfg = parsed.data

  // Env overrides (the only ones we still need — API keys are AI SDK's job).
  if (env[ENV_DISABLED] === "1") cfg.enabled = false
  if (env[ENV_MUTE] === "1") cfg.startMuted = true

  return { ok: true, config: cfg }
}
