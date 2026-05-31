import "source-map-support/register"
import { describe, it, expect } from "vitest"
import { serializeError } from "../src/log.js"

function throwHere(): never {
  throw new Error("source-map probe")
}

describe("serializeError with source maps", () => {
  it("resolves stack frames to the TypeScript source file", () => {
    let captured: Error | null = null
    try {
      throwHere()
    } catch (e) {
      captured = e as Error
    }
    expect(captured).not.toBeNull()
    const out = serializeError(captured!)
    expect(out.file ?? "").toMatch(/log\.source-maps\.test\.ts$/)
    expect(typeof out.line).toBe("number")
    expect(out.function ?? "").toMatch(/throwHere/)
  })
})
