import { describe, it, expect } from "vitest"
import {
  parseConfig,
  DEFAULT_CONFIG,
  DEFAULT_TTS_MODEL,
  DEFAULT_NARRATOR_MODEL,
  DEFAULT_GREETING,
  ENV_DISABLED,
  ENV_MUTE,
} from "../src/config.js"
import { EVENT_SPECS } from "../src/events/catalog.js"

describe("parseConfig", () => {
  it("returns defaults when given empty object", () => {
    const result = parseConfig({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.enabled).toBe(true)
      expect(result.config.tts.model).toBe(DEFAULT_TTS_MODEL)
      expect(result.config.narrator.model).toBe(DEFAULT_NARRATOR_MODEL)
      expect(result.config.events["session.idle"].enabled).toBe(true)
      expect(result.config.events["session.idle"].mode).toBe("narrate")
    }
  })

  it("accepts new-shape openai TTS slug", () => {
    const result = parseConfig({
      tts: { model: DEFAULT_TTS_MODEL, voice: "alloy" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.tts.model).toBe(DEFAULT_TTS_MODEL)
      expect(result.config.tts.voice).toBe("alloy")
    }
  })

  it("accepts new-shape elevenlabs TTS slug", () => {
    const result = parseConfig({
      tts: { model: "elevenlabs/eleven_turbo_v2_5", voice: "voice-id-123" },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.tts.model).toBe("elevenlabs/eleven_turbo_v2_5")
      expect(result.config.tts.voice).toBe("voice-id-123")
    }
  })

  it("rejects malformed tts.model slug", () => {
    const result = parseConfig({ tts: { model: "notaslug" } })
    expect(result.ok).toBe(false)
  })

  it("rejects malformed narrator.model slug", () => {
    const result = parseConfig({ narrator: { model: "no slash" } })
    expect(result.ok).toBe(false)
  })

  it("merges user-provided event overrides with defaults", () => {
    const result = parseConfig({
      events: { "tool.execute.before": { enabled: true } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.events["tool.execute.before"].enabled).toBe(true)
      expect(result.config.events["session.idle"].enabled).toBe(true)
    }
  })

  it("rejects rate out of bounds", () => {
    const result = parseConfig({ tts: { rate: 10 } })
    expect(result.ok).toBe(false)
  })

  it(`respects ${ENV_MUTE} env override`, () => {
    const result = parseConfig({}, { [ENV_MUTE]: "1" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.startMuted).toBe(true)
  })

  it(`disables plugin when ${ENV_DISABLED} is set`, () => {
    const result = parseConfig({}, { [ENV_DISABLED]: "1" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.enabled).toBe(false)
  })

  it("defaults greeting to the canonical greeting", () => {
    const result = parseConfig({})
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.greeting).toBe(DEFAULT_GREETING)
  })

  it("allows overriding the greeting string", () => {
    const result = parseConfig({ greeting: "hello there" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.greeting).toBe("hello there")
  })

  it("allows disabling greeting via empty string", () => {
    const result = parseConfig({ greeting: "" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.config.greeting).toBe("")
  })

  it("preserves unknown event keys for forward compat", () => {
    const result = parseConfig({
      events: { "future.event.type": { enabled: true, mode: "template" } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.events["future.event.type"]).toBeDefined()
    }
  })

  it("returns a parse error instead of throwing when an event override is null", () => {
    expect(() => parseConfig({ events: { "session.idle": null } })).not.toThrow()
    const result = parseConfig({ events: { "session.idle": null } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0].path).toBe("events.session.idle")
    }
  })

  it("returns a parse error instead of throwing when an event override is a primitive", () => {
    expect(() => parseConfig({ events: { "session.idle": true } })).not.toThrow()
    const result = parseConfig({ events: { "session.idle": true } })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors[0].path).toBe("events.session.idle")
    }
  })

  it("supports minimal verbosity for only important spoken events", () => {
    const result = parseConfig({ verbosity: "minimal" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const enabled = Object.entries(result.config.events)
        .filter(([, v]) => v.enabled)
        .map(([k]) => k)
        .sort()
      expect(enabled).toEqual([
        "permission.asked",
        "session.error",
        "session.idle",
        "todo.completed.all",
      ])
    }
  })

  it("supports verbose verbosity by keeping all default enabled events", () => {
    const result = parseConfig({ verbosity: "verbose" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.events["tool.execute.before"].enabled).toBe(true)
      expect(result.config.events["message.reasoning.delta"].enabled).toBe(true)
      expect(result.config.events["todo.completed.item"].enabled).toBe(true)
    }
  })

  it("lets explicit event overrides win over verbosity presets", () => {
    const result = parseConfig({
      verbosity: "minimal",
      events: { "tool.execute.before": { enabled: true } },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.events["tool.execute.before"].enabled).toBe(true)
    }
  })
})

describe("DEFAULT_CONFIG", () => {
  it("matches the canonical event catalog", () => {
    const expected = Object.fromEntries(
      Object.entries(EVENT_SPECS).map(([type, spec]) => [
        type,
        {
          enabled: spec.defaultEnabled.normal,
          mode: spec.mode,
          ...(spec.priority ? { priority: spec.priority } : {}),
        },
      ]),
    )
    expect(DEFAULT_CONFIG.events).toEqual(expected)
  })

  it("has all expected on-by-default events", () => {
    const enabled = Object.entries(DEFAULT_CONFIG.events)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k)
      .sort()
    expect(enabled).toEqual([
      "command.executed",
      "file.edited",
      "message.reasoning.delta",
      "permission.asked",
      "permission.replied",
      "session.compacted",
      "session.created",
      "session.error",
      "session.idle",
      "todo.completed.all",
      "todo.completed.item",
      "tool.execute.after",
      "tool.execute.before",
    ])
  })

  it("leaves verbatim text streaming opt-in but reasoning narration on", () => {
    expect(DEFAULT_CONFIG.events["message.updated"].enabled).toBe(false)
    expect(DEFAULT_CONFIG.events["message.text.delta"].enabled).toBe(false)
    expect(DEFAULT_CONFIG.events["message.text.delta"].mode).toBe("verbatim")
    expect(DEFAULT_CONFIG.events["message.reasoning.delta"].enabled).toBe(true)
    expect(DEFAULT_CONFIG.events["message.reasoning.delta"].mode).toBe("verbatim")
    expect(DEFAULT_CONFIG.events["message.reasoning.delta"].priority).toBe("chatty")
  })
})
