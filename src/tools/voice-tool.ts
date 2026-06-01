import { z } from "zod"
import { PLUGIN_NAME } from "../config.js"
import { runVoiceAction, VOICE_ACTION_ALIASES } from "../commands/actions.js"

interface VoiceToolCommands {
  stop(): void
  mute(): void
  unmute(): void
  toggle(): boolean
  say(text: string): void
  test(): void
  status(): unknown
}

const VoiceActionSchema = z.enum([
  "stop",
  "mute",
  "off",
  "unmute",
  "on",
  "toggle",
  "say",
  "test",
  "status",
])

export type VoiceToolArgs = {
  action: z.infer<typeof VoiceActionSchema>
  text?: string
}

export function createVoiceTool(commands: VoiceToolCommands) {
  return {
    description:
      `Control the ${PLUGIN_NAME} plugin. Actions: stop (interrupt current speech + drop queue, keep enabled), mute/off (silence + drop queue + disable), unmute/on (re-enable), toggle (flip mute), say (speak arbitrary text), test (canned line for verifying audio), status (report provider, voice, mute state, queue size).`,
    args: {
      action: VoiceActionSchema,
      text: z.string().optional(),
    },
    async execute(args: VoiceToolArgs) {
      return runVoiceAction(commands, VOICE_ACTION_ALIASES[args.action], args.text)
    },
  }
}
