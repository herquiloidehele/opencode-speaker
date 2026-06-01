import { commandNameFromEvent, type RawEvent } from "../events/normalize.js"
import { runVoiceAction } from "./actions.js"

interface ShortcutCommands {
  stop(): void
  mute(): void
  unmute(): void
  toggle(): boolean
  status(): unknown
  say(text: string): void
  test(): void
}

export type ShortcutHandlers = Record<string, () => string>

export function createShortcutHandlers(commands: ShortcutCommands): ShortcutHandlers {
  return {
    "voice-stop": () => {
      return runVoiceAction(commands, "stop")
    },
    "voice-off": () => {
      return runVoiceAction(commands, "mute")
    },
    "voice-on": () => {
      return runVoiceAction(commands, "unmute")
    },
    "voice-toggle": () => {
      return runVoiceAction(commands, "toggle")
    },
  }
}

export function extractCommandName(event: RawEvent): string | null {
  return commandNameFromEvent(event)
}
