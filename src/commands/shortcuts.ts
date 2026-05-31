interface ShortcutCommands {
  stop(): void
  mute(): void
  unmute(): void
  toggle(): boolean
}

export type ShortcutHandlers = Record<string, () => string>

export function createShortcutHandlers(commands: ShortcutCommands): ShortcutHandlers {
  return {
    "voice-stop": () => {
      commands.stop()
      return "stopped"
    },
    "voice-off": () => {
      commands.mute()
      return "muted"
    },
    "voice-on": () => {
      commands.unmute()
      return "unmuted"
    },
    "voice-toggle": () => {
      const nowMuted = commands.toggle()
      return nowMuted ? "muted" : "unmuted"
    },
  }
}

export function extractCommandName(event: { [k: string]: unknown }): string | null {
  const props = event.properties && typeof event.properties === "object"
    ? event.properties as Record<string, unknown>
    : event
  const candidates = [
    props.command,
    props.name,
    props.id,
    event.command,
    event.name,
  ]
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) {
      return c.replace(/^\/+/, "").toLowerCase()
    }
  }
  return null
}
