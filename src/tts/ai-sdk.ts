import { experimental_generateSpeech as generateSpeech, type SpeechModel } from "ai"
import type { TTSProvider, SynthesisOptions, SynthesisResult } from "./provider.js"

interface AiSdkProviderConfig {
  model: SpeechModel
  provider: "openai" | "elevenlabs"
  voice?: string
}

export function createAiSdkProvider(config: AiSdkProviderConfig): TTSProvider {
  const { model, provider: providerName, voice: defaultVoice } = config

  return {
    name: providerName,

    async synthesize(
      text: string,
      opts: SynthesisOptions,
      signal: AbortSignal,
    ): Promise<SynthesisResult> {
      const voice =
        opts.voice ??
        defaultVoice ??
        (providerName === "openai" ? "alloy" : undefined)

      const result = await generateSpeech({
        model,
        text,
        voice,
        outputFormat: "mp3",
        speed: opts.rate,
        abortSignal: signal,
      })
      return {
        audio: Buffer.from(result.audio.uint8Array),
        contentType: result.audio.mediaType ?? "audio/mpeg",
      }
    },
  }
}
