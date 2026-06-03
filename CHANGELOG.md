# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-01

### Added
- Initial public release.
- Speaks opencode agent activity out loud through pluggable text-to-speech provider.
- TTS providers: OpenAI (default) and ElevenLabs.
- LLM narrator providers: OpenAI and Anthropic, via the Vercel AI SDK (v6).
- Event catalog with per-event modes (`template`, `narrate`, `verbatim`) and
  verbosity profiles (`minimal`, `normal`, `verbose`).
- Configurable startup greeting, mute / start-muted controls, and rate-limited narration.
- Graceful degradation: the plugin disables itself with a toast instead of crashing
  opencode on misconfiguration or missing credentials.

[1.0.0]: https://github.com/herquiloidehele/opencode-speaker/releases/tag/v1.0.0
