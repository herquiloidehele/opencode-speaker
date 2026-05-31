import { describe, it, expect } from "vitest"
import { requiredEnvVar, checkCredentials } from "../src/ai-sdk/credentials.js"

describe("requiredEnvVar", () => {
  it.each([
    ["openai/gpt-4.1-mini", "OPENAI_API_KEY"],
    ["openai/gpt-4o-mini-tts", "OPENAI_API_KEY"],
    ["anthropic/claude-haiku-4", "ANTHROPIC_API_KEY"],
    ["elevenlabs/eleven_turbo_v2_5", "ELEVENLABS_API_KEY"],
  ])("maps %s to %s", (slug, env) => {
    expect(requiredEnvVar(slug)).toBe(env)
  })

  it.each([
    ["foo/bar"],
    ["openai"],
    [""],
    ["/no-prefix"],
  ])("returns null for unmapped or malformed slug %s", (slug) => {
    expect(requiredEnvVar(slug)).toBeNull()
  })
})

describe("checkCredentials", () => {
  it("ok when both providers' env vars are present", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        { OPENAI_API_KEY: "k" },
      ),
    ).toEqual({ ok: true })
  })

  it("de-duplicates when narrator and tts share a provider", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        {},
      ),
    ).toEqual({ ok: false, missing: ["OPENAI_API_KEY"] })
  })

  it("reports both missing keys when providers differ", () => {
    expect(
      checkCredentials(
        { narratorSlug: "anthropic/a", ttsSlug: "elevenlabs/b" },
        {},
      ),
    ).toEqual({ ok: false, missing: ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"] })
  })

  it("treats empty string as missing", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        { OPENAI_API_KEY: "" },
      ),
    ).toEqual({ ok: false, missing: ["OPENAI_API_KEY"] })
  })

  it("treats whitespace-only as missing", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "openai/y" },
        { OPENAI_API_KEY: "   " },
      ),
    ).toEqual({ ok: false, missing: ["OPENAI_API_KEY"] })
  })

  it("ignores unknown providers (slug resolver catches them separately)", () => {
    expect(
      checkCredentials(
        { narratorSlug: "openai/x", ttsSlug: "foo/bar" },
        { OPENAI_API_KEY: "k" },
      ),
    ).toEqual({ ok: true })
  })

  it("missing array is sorted", () => {
    const result = checkCredentials(
      { narratorSlug: "elevenlabs/x", ttsSlug: "anthropic/y" },
      {},
    )
    expect(result).toEqual({
      ok: false,
      missing: ["ANTHROPIC_API_KEY", "ELEVENLABS_API_KEY"],
    })
  })
})
