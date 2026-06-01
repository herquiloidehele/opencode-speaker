import "source-map-support/register.js"
import { parseConfig, PLUGIN_NAME, type VoiceConfig } from "./config.js"
import { createLogger, type Logger } from "./log.js"
import { SpeechQueue } from "./queue/speech-queue.js"
import { type SpeechRequest } from "./queue/types.js"
import { createAiSdkProvider } from "./tts/ai-sdk.js"
import { createPlayer, type Player } from "./audio/player.js"
import { defaultRunner } from "./audio/runner.js"
import { createHandlerRegistry } from "./handlers/index.js"
import { createNarrator } from "./handlers/narrator.js"
import {
  resolveLanguageModel,
  resolveSpeechModel,
  ConfigError,
} from "./ai-sdk/models.js"
import { createDispatcher } from "./dispatcher.js"
import { createCommands } from "./commands/index.js"
import { createShortcutHandlers, extractCommandName } from "./commands/shortcuts.js"
import { createVoiceTool } from "./tools/voice-tool.js"
import { createNotifier } from "./notify.js"
import { checkCredentials } from "./ai-sdk/credentials.js"

// IMPORTANT: do not re-export anything that opencode's plugin loader might
// mistake for a server plugin. The loader uses the v1 default-export contract
// `{ id, server }` (see `default` below) — that path skips the legacy scan
// that would otherwise iterate every module export. Putting public API
// (registerProvider, types) here would put them in `Object.values(mod)` and
// could break older loaders. They live in `./api.ts` instead.

type PluginCtx = {
  client: {
    app: { log: (...args: any[]) => Promise<unknown> }
  }
  directory: string
  worktree?: string
  project?: unknown
  $: unknown
}

type PluginOptions = Record<string, unknown> | undefined
type Notifier = ReturnType<typeof createNotifier>

function formatSchemaErrors(errors: { path: string; message: string }[]): string {
  const parts = errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message))
  return `invalid config — ${parts.join("; ")}`
}

function oneLine(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err)
  return s.replace(/\s+/g, " ").trim()
}

export const OpencodeSpeaker = async (ctx: PluginCtx, options?: PluginOptions) => {
  try {
    return await initPlugin(ctx, options)
  } catch (err) {
    // Last-line-of-defense: never let plugin failure crash opencode startup.
    try {
      const logger = createLogger(ctx.client as any, PLUGIN_NAME).child({ module: "init" })
      const notifier = createNotifier(ctx.client as any, logger)
      notifier.fatal("failed to initialize; plugin disabled", {
        error: err,
        operation: "initializing plugin",
      })
    } catch {
      /* logger/notifier itself failed; nothing we can safely do */
    }
    return {}
  }
}

async function initPlugin(ctx: PluginCtx, options?: PluginOptions) {
  const logger = createLogger(ctx.client as any, PLUGIN_NAME)
  const initLog     = logger.child({ module: "init" })
  const dispatchLog = logger.child({ module: "dispatcher" })
  const queueLog    = logger.child({ module: "queue" })
  const narratorLog = logger.child({ module: "narrator" })
  const audioLog    = logger.child({ module: "audio" })
  const ttsLog      = logger.child({ module: "tts" })
  const notifier = createNotifier(ctx.client as any, initLog)
  // opencode passes per-plugin config as the second argument when the user
  // declares the plugin in tuple form: ["opencode-speaker", { ...options }].
  // We accept any user object and let parseConfig validate + apply defaults.
  const config = loadConfig(options, notifier)
  if (!config) {
    return {}
  }

  if (!config.enabled) {
    await initLog.info(`${PLUGIN_NAME} disabled by config or env`, {
      operation: "starting plugin",
    })
    return {}
  }

  // 1. Resolve narrator + TTS models from config slugs.
  const models = resolveModelsOrDisable(config, notifier)
  if (!models) {
    return {}
  }
  const { languageModel, resolvedSpeech } = models

  const credCheck = checkCredentials(
    { narratorSlug: config.narrator.model, ttsSlug: config.tts.model },
    process.env,
  )
  if (!credCheck.ok) {
    notifier.fatal(
      `${credCheck.missing.join(", ")} not set; plugin disabled`,
      {
        operation: "checking provider credentials",
        input: { missing: credCheck.missing },
      },
    )
    return {}
  }

  // 2. Build the AI SDK TTS provider.
  const provider = createAiSdkProvider({
    model: resolvedSpeech.model,
    provider: resolvedSpeech.provider,
    voice: config.tts.voice,
  })

  // 3. Set up audio player. The AI SDK provider returns raw audio bytes that
  // we need to hand off to the OS's audio playback binary.
  const player = await initPlayer(audioLog)

  // 4. Build the speak function used by the queue.
  const ttsConfig = config.tts
  async function speak(req: SpeechRequest, signal: AbortSignal): Promise<void> {
    if (!player) return
    const result = await provider.synthesize(
      req.text,
      {
        voice: ttsConfig.voice,
        rate: ttsConfig.rate,
      },
      signal,
    )
    await player.play(result.audio, result.contentType, signal)
  }

  // 5. Wire queue.
  const queue = new SpeechQueue({
    speak,
    staleMs: config.queue.staleMs,
    now: () => Date.now(),
    logger: queueLog,
    onError: (err, req) => {
      void queueLog.warn("speak failed", {
        error: err,
        operation: "speaking queued request",
        input: { textPreview: req.text.slice(0, 80), priority: req.priority },
      })
    },
  })

  // 6. Narrator + handler registry.
  const narrator = createNarrator(languageModel, config.narrator, narratorLog)

  const dispatcher = createDispatcher({
    logger: dispatchLog,
    handler: createHandlerRegistry({
      events: config.events as any,
      narrator,
      getContext: () => dispatcher.getContext(),
    }),
    queue,
    onError: (err, e) => {
      void dispatchLog.warn("handler error at boundary", {
        error: err,
        operation: "dispatcher onError boundary",
        input: { eventType: e.type },
      })
    },
  })

  // 7. Commands + custom tool.
  const commands = createCommands({
    queue,
    providerName: resolvedSpeech.provider,
    voiceName: config.tts.voice,
  })
  if (config.startMuted) commands.mute()

  await initLog.info(`${PLUGIN_NAME} ready`, {
    operation: "plugin ready",
    input: { provider: resolvedSpeech.provider, voice: config.tts.voice },
  })

  if (config.greeting.trim().length > 0 && !config.startMuted) {
    commands.say(config.greeting)
  }

  // Slash-command shortcuts intercepted from the TUI. These bypass the LLM
  // for instant response (interrupt/mute take effect immediately, not after
  // the model decides to call a tool).
  //
  // The exact wire shape of `tui.command.execute` differs across opencode
  // versions, so we read defensively from common locations.
  const shortcutHandlers = createShortcutHandlers(commands)

  return {
    event: async ({
      event,
    }: {
      event: { type: string; [k: string]: unknown }
    }) => {
      // The dispatcher is the single entry point: it knows how to unwrap
      // OpenCode's `{ id, type, properties }` shape, fan out synthesized
      // events (todo.completed.*, message.reasoning.delta, message.text.delta),
      // and keep narration context fresh.
      try {
        await dispatcher.onEvent(event)
      } catch (err) {
        await dispatchLog.warn("event handler crashed", {
          error: err,
          operation: "dispatching opencode event",
          input: { eventType: event.type },
        })
      }
    },
  }
}

function loadConfig(options: PluginOptions, notifier: Notifier): VoiceConfig | null {
  const parsed = parseConfig(options ?? {})

  if (!parsed.ok) {
    notifier.fatal(formatSchemaErrors(parsed.errors), {
      operation: "parsing plugin config",
      input: { errors: parsed.errors },
    })
    return null
  }

  return parsed.config
}

function resolveModelsOrDisable(config: VoiceConfig, notifier: Notifier) {
  try {
    return {
      languageModel: resolveLanguageModel(config.narrator.model),
      resolvedSpeech: resolveSpeechModel(config.tts.model),
    }
  } catch (err) {
    const summary = err instanceof ConfigError
      ? `invalid model slug — ${err.message}`
      : `failed to resolve models — ${oneLine(err)}`
    notifier.fatal(summary, {
      error: err,
      operation: "resolving model slugs",
      input: { narrator: config.narrator.model, tts: config.tts.model },
    })
    return null
  }
}

async function initPlayer(audioLog: Logger): Promise<Player | null> {
  try {
    const runner = await defaultRunner()
    const player = createPlayer({ runner })
    await player.init()
    return player
  } catch (err) {
    await audioLog.warn("Audio player unavailable; speech output disabled", {
      error: err,
      operation: "initializing audio player",
      input: { platform: process.platform },
    })
    return null
  }
}

/**
 * Default export is the plugin function itself, matching the current
 * `@opencode-ai/plugin` contract (see ExamplePlugin / FolderWorkspacePlugin).
 *
 * History: this used to be `{ id, server: OpencodeSpeaker }` to satisfy an
 * older "v1" loader shape. Newer opencode releases reject that as
 * "does not expose a server entrypoint" — the loader expects the default
 * export to be the async plugin function directly.
 *
 * `index.ts` deliberately has no other exports beyond `OpencodeSpeaker` and
 * this default, so the loader's named-export scan (if any) does not invoke
 * a second plugin instance. Public API lives in `./api.ts`.
 */
export default OpencodeSpeaker
