/**
 * Public API for opencode-speaker. Runtime provider selection is owned by the
 * plugin startup path; this module only exposes stable provider-related types.
 */
export type {
  TTSProvider,
  SynthesisOptions,
  SynthesisResult,
} from "./tts/provider.js"
