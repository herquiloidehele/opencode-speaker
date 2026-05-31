import { describe, expect, it, vi } from "vitest"
import { createShortcutHandlers, extractCommandName } from "../src/commands/shortcuts.js"

describe("command shortcuts", () => {
  it("extracts command names from top-level command fields", () => {
    expect(extractCommandName({ type: "command.executed", command: "/voice-stop" })).toBe("voice-stop")
  })

  it("extracts command names from event properties", () => {
    expect(extractCommandName({
      type: "command.executed",
      properties: { name: "/voice-toggle" },
    })).toBe("voice-toggle")
  })

  it("returns null when no command name exists", () => {
    expect(extractCommandName({ type: "command.executed", properties: {} })).toBeNull()
  })

  it("handles stop, mute, unmute, and toggle actions", () => {
    const commands = {
      stop: vi.fn(),
      mute: vi.fn(),
      unmute: vi.fn(),
      toggle: vi.fn().mockReturnValue(true),
    }
    const handlers = createShortcutHandlers(commands)

    expect(handlers["voice-stop"]()).toBe("stopped")
    expect(handlers["voice-off"]()).toBe("muted")
    expect(handlers["voice-on"]()).toBe("unmuted")
    expect(handlers["voice-toggle"]()).toBe("muted")

    expect(commands.stop).toHaveBeenCalledTimes(1)
    expect(commands.mute).toHaveBeenCalledTimes(1)
    expect(commands.unmute).toHaveBeenCalledTimes(1)
    expect(commands.toggle).toHaveBeenCalledTimes(1)
  })
})
