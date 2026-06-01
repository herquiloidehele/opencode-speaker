# opencode-speaker

A speaker plugin for [opencode](https://opencode.ai) that **speaks agent activity out loud** through pluggable text-to-speech backends.

Hear what your agent is doing while you work on something else — session summaries, errors, permission requests, and todo completions, narrated by an LLM and spoken by a TTS model.

Supports **OpenAI** (default) and **ElevenLabs** for TTS, with **OpenAI** or **Anthropic** for the LLM narrator. Powered by the [Vercel AI SDK](https://sdk.vercel.ai).

---

## Install

### 1. Add the plugin to `opencode.json`

Your global opencode config file is usually located at `~/.config/opencode/opencode.json`.
If you use a project-local opencode config, add the same plugin entry there instead.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-speaker"]
}
```

### 2. Set your OpenAI API key

For the current terminal session:

```bash
export OPENAI_API_KEY=sk-...
```

To make it available every time you open a terminal, add it to your shell startup file:

```bash
# zsh, macOS default
echo 'export OPENAI_API_KEY=sk-...' >> ~/.zshrc

# bash
echo 'export OPENAI_API_KEY=sk-...' >> ~/.bashrc
```

If you use fish:

```fish
set -Ux OPENAI_API_KEY sk-...
```

Restart your terminal after adding the variable, or run `source ~/.zshrc` / `source ~/.bashrc` for the current session.

That's it. Start opencode and you'll hear a short greeting confirming the plugin is ready.

By default, the plugin uses:
- TTS model: `openai/gpt-4o-mini-tts`
- Narrator model: `openai/gpt-4.1-mini`

And out of the box, you'll hear:
- Session starts, idle summaries, errors, and compactions
- Permission requests and replies
- Tool starts and finishes
- File edits and executed commands
- Reasoning deltas while the assistant is thinking
- Todo item completions and “all todos complete” summaries

---

## Using ElevenLabs instead

Configure the plugin using the **tuple form** in the `plugin` array (per-plugin config goes as the second tuple element — not as a top-level key):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-speaker", {
      "tts": {
        "model": "elevenlabs/eleven_turbo_v2_5",
        "voice": "EXAVITQu4vr4xnSDxMaL"
      }
    }]
  ]
}
```

Then set your API key:

```bash
export ELEVENLABS_API_KEY=...
```

The `voice` field takes an ElevenLabs voice ID.

> **Note:** The narrator (LLM summarizer) is separate from TTS. You can mix and match — e.g., narrate with Anthropic, speak with ElevenLabs.

---

## Configuration

All options go inside the tuple's second element: `["opencode-speaker", { ... }]`.

### Full example

```json
{
  "plugin": [
    ["opencode-speaker", {
      "greeting": "opencode speaker ready",
      "tts": {
        "model": "openai/gpt-4o-mini-tts",
        "voice": "nova",
        "rate": 1.0
      },
      "narrator": {
        "model": "openai/gpt-4.1-mini",
        "timeoutMs": 5000,
        "minIntervalMs": 3000
      },
      "events": {
        "tool.execute.before": { "enabled": true }
      }
    }]
  ]
}
```

### TTS providers

| Provider | Model slug example | Voices | Env var |
|---|---|---|---|
| OpenAI (default) | `openai/gpt-4o-mini-tts`, `openai/tts-1`, `openai/tts-1-hd` | `alloy`, `ash`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, `shimmer` | `OPENAI_API_KEY` |
| ElevenLabs | `elevenlabs/eleven_turbo_v2_5` | ElevenLabs voice ID | `ELEVENLABS_API_KEY` |

### Narrator (LLM) providers

| Provider | Model slug example | Env var |
|---|---|---|
| OpenAI (default) | `openai/gpt-4.1-mini` | `OPENAI_API_KEY` |
| Anthropic | `anthropic/claude-haiku-4` | `ANTHROPIC_API_KEY` |

The plugin resolves `provider/model` slugs internally — no imports needed.

### Events

Each event is independently configurable.

### Verbosity

Use `verbosity` to choose a default event profile, then override individual events as needed.

| Value | Behavior |
|---|---|
| `minimal` | Speaks only session idle summaries, session errors, permission requests, and all-todos-complete summaries. |
| `normal` | Current default event profile. |
| `verbose` | Same as `normal` today; reserved for future high-detail defaults while preserving a stable option name. |

```json
{
  "plugin": [
    ["opencode-speaker", {
      "verbosity": "minimal",
      "events": {
        "tool.execute.before": { "enabled": true }
      }
    }]
  ]
}
```

| Event | Default | Mode |
|---|---|---|
| `session.idle` | on | narrate (LLM summary) |
| `session.error` | on | template, urgent |
| `session.compacted` | on | template |
| `session.created` | on | template |
| `permission.asked` | on | template, urgent |
| `permission.replied` | on | template |
| `tool.execute.before` | on | template, chatty |
| `tool.execute.after` | on | template, chatty |
| `file.edited` | on | template, chatty |
| `command.executed` | on | template |
| `message.reasoning.delta` | on | verbatim, chatty |
| `message.text.delta` | off | verbatim, chatty |
| `message.updated` | off | verbatim |
| `todo.completed.item` | on | template, chatty |
| `todo.completed.all` | on | narrate |

Override per event:

```json
{
  "events": {
    "tool.execute.before": { "enabled": true, "mode": "template" }
  }
}
```

Modes:
- `template` — fixed phrasing (fast, no LLM)
- `narrate` — LLM-generated summary (concise but covers what happened, blockers, next steps)
- `verbatim` — speak the raw text as-is

The narrator is rate-limited by `minIntervalMs` and falls back to a template if the call fails or is throttled.

### Greeting

A short startup line, spoken once when the plugin is ready. Default: `"Welcome to OpenCode Speaker!"`.

```json
{ "greeting": "welcome back" }
```

Set to `""` to disable. Skipped automatically when `startMuted: true` or `OPENCODE_VOICE_MUTE=1`.

### Environment flags

- `OPENCODE_VOICE_MUTE=1` — start muted
- `OPENCODE_VOICE_DISABLED=1` — load the plugin but do nothing

---

## Controls

### Slash commands

These intercept the TUI directly — no LLM round-trip, so they take effect immediately, even mid-sentence:

| Command | Effect |
|---|---|
| `/voice-stop` | Interrupt + drop queue. Plugin stays enabled. |
| `/voice-off` | Mute: interrupt + drop queue + silence future events. |
| `/voice-on` | Re-enable speech. |
| `/voice-toggle` | Flip between on and off. |

Register them in `opencode.json`:

```jsonc
{
  "command": {
    "voice-stop":   { "description": "Stop speaking now",   "template": "Call the voice tool with action stop." },
    "voice-off":    { "description": "Mute the voice",      "template": "Call the voice tool with action mute." },
    "voice-on":     { "description": "Unmute the voice",    "template": "Call the voice tool with action unmute." },
    "voice-toggle": { "description": "Toggle voice on/off", "template": "Call the voice tool with action toggle." }
  }
}
```

Bind them to keys via [opencode keybinds](https://opencode.ai/docs/keybinds/) — e.g. `Esc` → `/voice-stop` for a panic button.

### `voice` tool

The agent (or you) can call the `voice` custom tool:

| Action | Effect |
|---|---|
| `{ "action": "stop" }` | Interrupt and drop queue, keep enabled. |
| `{ "action": "mute" }` (alias `off`) | Drop queue and silence future events. |
| `{ "action": "unmute" }` (alias `on`) | Re-enable. |
| `{ "action": "toggle" }` | Flip mute; returns `muted` or `unmuted`. |
| `{ "action": "say", "text": "hello" }` | Speak arbitrary text. |
| `{ "action": "test" }` | Speak a canned line — useful for verifying setup. |
| `{ "action": "status" }` | JSON status (provider, voice, mute state, queue size). |

---

## Custom providers

Runtime provider selection is currently built in. TTS slugs route `openai/*` and
`elevenlabs/*`; narrator slugs route `openai/*` and `anthropic/*`.

The `opencode-speaker/api` entrypoint exports provider-related TypeScript types
for integrations, but it does not register custom providers at runtime. To add a
provider today, fork the model resolver in `src/ai-sdk/models.ts` or open an
issue.

---

## Troubleshooting

**No audio on Linux:** install `speech-dispatcher` (`sudo apt install speech-dispatcher`) or `espeak`. For cloud-provider audio playback, install `pulseaudio-utils` (`paplay`), `alsa-utils` (`aplay`), or `ffmpeg` (`ffplay`).

**Windows blocked by execution policy:** run PowerShell once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Plugin disabled with a toast on startup:** the toast carries a short summary (invalid config, missing API key, TTS init failure). The full structured detail is in opencode's log file — `opencode-speaker` errors are logged at `error` / `warn` level.

**`Unrecognized key: voice` schema error:** you put options at the top level. Use the tuple form: `"plugin": [["opencode-speaker", { ... }]]`, not `"voice": { ... }`.

---

## Development

Six runnable demo scripts exercise each feature without booting opencode (all use `tsx`):

| Script | Validates |
|---|---|
| `npm run demo:say -- "text"` | Synthesis + playback. Override TTS with `--model=elevenlabs/eleven_turbo_v2_5 --voice=<id>`. |
| `npm run demo:queue` | Speech queue priority + dedup behavior. |
| `npm run demo:event -- <event.type>` | Full event-to-audio pipeline. E.g. `session.idle`, `permission.asked --tool=write`. |
| `npm run demo:narrator -- --assistant-text="..." --tool=bash` | LLM narrator handler. |
| `npm run demo:config -- '{...}'` or `--file=path.json` | Validate a config block against the Zod schema. |
| `npm run demo:greet` | Startup greeting via the full plugin. |

Standard commands:

```bash
npm test          # full unit + integration suite
npm run typecheck # TypeScript validation
npm run build     # produce dist/
```

To restart opencode against a local build:

```bash
rm -rf ~/.cache/opencode/node_modules/opencode-speaker && npm run build
```

---

## License

MIT.
