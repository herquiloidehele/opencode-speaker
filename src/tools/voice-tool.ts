import { z } from "zod"
import { PLUGIN_NAME } from "../config.js"

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
      if (args.action === "stop") {
        commands.stop()
        return "stopped"
      }
      if (args.action === "mute" || args.action === "off") {
        commands.mute()
        return "muted"
      }
      if (args.action === "unmute" || args.action === "on") {
        commands.unmute()
        return "unmuted"
      }
      if (args.action === "toggle") {
        const nowMuted = commands.toggle()
        return nowMuted ? "muted" : "unmuted"
      }
      if (args.action === "say") {
        commands.say(args.text ?? "")
        return "queued"
      }
      if (args.action === "test") {
        commands.test()
        return "test queued"
      }
      return JSON.stringify(commands.status())
    },
  }
}
