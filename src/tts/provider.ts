export interface SynthesisOptions {
  voice?: string
  rate?: number
}

export interface SynthesisResult {
  audio: Buffer
  contentType: string
}

export interface TTSProvider {
  readonly name: string
  synthesize(
    text: string,
    opts: SynthesisOptions,
    signal: AbortSignal,
  ): Promise<SynthesisResult>
}
