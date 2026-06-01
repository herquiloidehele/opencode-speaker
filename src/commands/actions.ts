export type VoiceAction = "stop" | "mute" | "unmute" | "toggle" | "say" | "test" | "status"

export interface ActionCommands {
  stop(): void
  mute(): void
  unmute(): void
  toggle(): boolean
  say(text: string): void
  test(): void
  status(): unknown
}

export const VOICE_ACTION_ALIASES: Record<string, VoiceAction> = {
  stop: "stop",
  mute: "mute",
  off: "mute",
  unmute: "unmute",
  on: "unmute",
  toggle: "toggle",
  say: "say",
  test: "test",
  status: "status",
}

export function runVoiceAction(commands: ActionCommands, action: VoiceAction, text = ""): string {
  if (action === "stop") {
    commands.stop()
    return "stopped"
  }
  if (action === "mute") {
    commands.mute()
    return "muted"
  }
  if (action === "unmute") {
    commands.unmute()
    return "unmuted"
  }
  if (action === "toggle") {
    return commands.toggle() ? "muted" : "unmuted"
  }
  if (action === "say") {
    commands.say(text)
    return "queued"
  }
  if (action === "test") {
    commands.test()
    return "test queued"
  }
  return JSON.stringify(commands.status())
}
