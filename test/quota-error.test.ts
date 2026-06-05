import { describe, expect, it } from "vitest"
import { isQuotaError } from "../src/errors/quota.js"

describe("isQuotaError", () => {
  it("detects the AI SDK retry error message for exceeded provider quota", () => {
    const err = Object.assign(
      new Error(
        "Failed after 3 attempts. Last error: You exceeded your current quota, please check your plan and billing details.",
      ),
      { name: "AI_RetryError" },
    )

    expect(isQuotaError(err)).toBe(true)
  })

  it("detects nested cause messages with insufficient_quota", () => {
    const err = new Error("wrapper", {
      cause: new Error("OpenAI request failed with insufficient_quota"),
    })

    expect(isQuotaError(err)).toBe(true)
  })

  it("detects generic quota exceeded wording", () => {
    expect(isQuotaError(new Error("ElevenLabs quota exceeded"))).toBe(true)
  })

  it("does not classify ordinary TTS failures as quota errors", () => {
    expect(isQuotaError(new Error("network timeout"))).toBe(false)
    expect(isQuotaError(new Error("rate limit"))).toBe(false)
    expect(isQuotaError(undefined)).toBe(false)
  })
})
