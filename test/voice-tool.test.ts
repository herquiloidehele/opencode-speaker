import { describe, expect, it, vi } from "vitest"
import { createVoiceTool } from "../src/tools/voice-tool.js"

describe("voice tool", () => {
  function setup() {
    const commands = {
      stop: vi.fn(),
      mute: vi.fn(),
      unmute: vi.fn(),
      toggle: vi.fn().mockReturnValue(false),
      say: vi.fn(),
      test: vi.fn(),
      status: vi.fn().mockReturnValue({ muted: false, queueSize: 0 }),
    }
    return { commands, tool: createVoiceTool(commands) }
  }

  it("executes stop, mute, unmute, and toggle actions", async () => {
    const { commands, tool } = setup()

    await expect(tool.execute({ action: "stop" })).resolves.toBe("stopped")
    await expect(tool.execute({ action: "mute" })).resolves.toBe("muted")
    await expect(tool.execute({ action: "unmute" })).resolves.toBe("unmuted")
    await expect(tool.execute({ action: "toggle" })).resolves.toBe("unmuted")

    expect(commands.stop).toHaveBeenCalledTimes(1)
    expect(commands.mute).toHaveBeenCalledTimes(1)
    expect(commands.unmute).toHaveBeenCalledTimes(1)
    expect(commands.toggle).toHaveBeenCalledTimes(1)
  })

  it("executes say, test, and status actions", async () => {
    const { commands, tool } = setup()

    await expect(tool.execute({ action: "say", text: "hello" })).resolves.toBe("queued")
    await expect(tool.execute({ action: "test" })).resolves.toBe("test queued")
    await expect(tool.execute({ action: "status" })).resolves.toBe(JSON.stringify({ muted: false, queueSize: 0 }))

    expect(commands.say).toHaveBeenCalledWith("hello")
    expect(commands.test).toHaveBeenCalledTimes(1)
    expect(commands.status).toHaveBeenCalledTimes(1)
  })
})
