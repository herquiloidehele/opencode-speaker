import { describe, it, expect, vi } from "vitest"
import { MockSpeechModelV2 } from "ai/test"
import { createAiSdkProvider } from "../src/tts/ai-sdk.js"

function mockSpeechModel(opts: {
  onCall?: (input: any) => void
  audio?: Uint8Array
  throwError?: Error
} = {}) {
  const doGenerate = vi.fn(async (input: any) => {
    if (opts.throwError) throw opts.throwError
    opts.onCall?.(input)
    return {
      audio: opts.audio ?? new Uint8Array([0x49, 0x44, 0x33]),
      warnings: [],
      request: { body: undefined },
      response: { timestamp: new Date(), modelId: "test", headers: {} },
    }
  })
  return { model: new MockSpeechModelV2({ doGenerate }), doGenerate }
}

describe("ai-sdk TTS provider", () => {
  it("returns a Buffer with an audio content type", async () => {
    const { model } = mockSpeechModel()
    const provider = createAiSdkProvider({ model, provider: "openai" })
    const result = await provider.synthesize(
      "hello",
      { voice: "alloy" },
      new AbortController().signal,
    )
    expect(Buffer.isBuffer(result.audio)).toBe(true)
    expect(result.contentType).toMatch(/audio\//)
  })

  it("uses 'alloy' as default voice for openai", async () => {
    let capturedVoice: string | undefined
    const { model } = mockSpeechModel({
      onCall: (input) => { capturedVoice = input.voice },
    })
    const provider = createAiSdkProvider({ model, provider: "openai" })
    await provider.synthesize("hi", {}, new AbortController().signal)
    expect(capturedVoice).toBe("alloy")
  })

  it("does not pass a voice for elevenlabs when none configured", async () => {
    let capturedVoice: string | undefined = "untouched"
    const { model } = mockSpeechModel({
      onCall: (input) => { capturedVoice = input.voice },
    })
    const provider = createAiSdkProvider({ model, provider: "elevenlabs" })
    await provider.synthesize("hi", {}, new AbortController().signal)
    expect(capturedVoice).toBeUndefined()
  })

  it("uses init-config voice as default when opts.voice unset", async () => {
    let capturedVoice: string | undefined
    const { model } = mockSpeechModel({
      onCall: (input) => { capturedVoice = input.voice },
    })
    const provider = createAiSdkProvider({ model, provider: "openai", voice: "nova" })
    await provider.synthesize("hi", {}, new AbortController().signal)
    expect(capturedVoice).toBe("nova")
  })

  it("opts.voice wins over init-config voice", async () => {
    let capturedVoice: string | undefined
    const { model } = mockSpeechModel({
      onCall: (input) => { capturedVoice = input.voice },
    })
    const provider = createAiSdkProvider({ model, provider: "openai", voice: "nova" })
    await provider.synthesize(
      "hi",
      { voice: "shimmer" },
      new AbortController().signal,
    )
    expect(capturedVoice).toBe("shimmer")
  })

  it("propagates abort signal", async () => {
    const doGenerate = vi.fn(async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500)
        abortSignal?.addEventListener("abort", () => {
          clearTimeout(t)
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
        })
      })
      throw new Error("should have aborted")
    })
    const model = new MockSpeechModelV2({ doGenerate })
    const provider = createAiSdkProvider({ model, provider: "openai" })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    await expect(
      provider.synthesize("hi", {}, ac.signal),
    ).rejects.toThrow(/abort/i)
  })

  it("surfaces model errors", async () => {
    const { model } = mockSpeechModel({ throwError: new Error("rate limit") })
    const provider = createAiSdkProvider({ model, provider: "openai" })
    await expect(
      provider.synthesize("hi", {}, new AbortController().signal),
    ).rejects.toThrow(/rate limit/)
  })

  it("name reflects the resolved provider", async () => {
    const { model } = mockSpeechModel()
    const provider = createAiSdkProvider({ model, provider: "elevenlabs" })
    expect(provider.name).toBe("elevenlabs")
  })

  it("creates an initialized provider with a fixed name", () => {
    const { model } = mockSpeechModel()
    const provider = createAiSdkProvider({ model, provider: "openai", voice: "nova" })

    expect(provider.name).toBe("openai")
  })
})
