# Passive TTY Hotkeys Design

> **Revision (2026-06-01, post-implementation):** The passive stdin hotkey
> listener was **removed**. Attaching a `data` listener to `process.stdin`
> forced the shared terminal stream into flowing mode and competed with the
> opencode TUI's own reader, so keystrokes alternated between consumers and
> every key had to be pressed twice. A plugin sharing the terminal process
> cannot safely tap stdin. The shipped mechanism is the **signal-file bus**
> only: the plugin watches a directory and reacts to `stop`/`mute` files, and
> the user binds a key **outside** opencode (terminal, multiplexer, or OS) to
> write those files. Sections below that describe the stdin listener and
> `control.hotkeys` config are retained for history but no longer apply.

## Goal

Give users a way to interrupt opencode-speaker audio immediately without sending a prompt to the LLM, without using slash commands, without exposing a `voice` tool, and without requiring terminal, tmux, HTTP server, or OS-level hotkey configuration.

The control must work while a session is generating and after generation has ended. It must not interrupt or otherwise affect opencode's session generation.

## Verified Constraints

opencode does not expose a plugin keybind API. The TUI keybind schema is a closed set of built-in action names and does not allow binding a key directly to a custom plugin handler.

Custom opencode commands are not suitable for voice control. Source review of opencode's command pipeline shows a command always creates a user message and runs the LLM loop unless the caller sets `noReply: true`. The `command.execute.before` plugin hook only receives command parts and cannot set `noReply`. Clearing those parts would still create an empty user turn and trigger an assistant response; throwing from the hook is treated as a plugin failure, not a clean cancellation path.

Therefore, the only no-setup in-process path is passive observation of terminal input from the plugin process.

## Proposed Behavior

By default:

- `F8` stops voice immediately.
- `F9` toggles mute.

The keys are configurable. The listener only acts while an opencode TUI running the plugin is focused, because that is the only time the process receives terminal input.

Pressing `F8` calls `commands.stop()`: abort the current utterance, drop queued speech, and keep future speech enabled.

Pressing `F9` toggles the shared mute state. If muted, future speech events are ignored and any current utterance is aborted. If unmuted, future events can speak again.

## Architecture

### Passive Hotkey Listener

Add `src/control/hotkeys.ts`.

The listener attaches a passive `data` handler to a readable stream, defaulting to `process.stdin`. It must not call `resume()`, `pause()`, `setRawMode()`, `setEncoding()`, or otherwise change terminal input behavior. opencode owns terminal mode; this plugin only observes bytes that already flow through the process.

The listener matches configured key sequences against incoming chunks. It supports named keys for practical defaults and JSON-escaped literal sequences for advanced users:

- `f8`
- `f9`
- Literal terminal sequences such as `"\u001b[19~"` for explicit escape bytes

Named defaults should include common terminal encodings for `F8` and `F9`, including xterm-style `ESC [ 19 ~` and `ESC [ 20 ~`, not a single sequence. If a terminal uses a different sequence, the user can override the config with a JSON-escaped literal sequence.

On match:

- `stop` calls `commands.stop()` and publishes a shared stop signal.
- `muteToggle` toggles shared mute state and applies the resulting state locally.

The listener returns a disposer that removes the `data` handler.

### Shared Signal Bus

Add `src/control/signals.ts`.

The signal bus is internal plumbing for multi-instance support. Users do not configure it or bind keys to it.

Default directory:

- `${XDG_CACHE_HOME}/opencode-speaker` if `XDG_CACHE_HOME` is set.
- Otherwise `${HOME}/.cache/opencode-speaker`.

Files:

- `stop`: edge-trigger file. Updating its mtime means "stop now".
- `mute`: presence-based state. Exists means muted; absent means unmuted.

Each plugin instance polls the signal directory on a small interval, default 200 ms. Polling is chosen instead of `fs.watch` because terminal and cache directory behavior differs across platforms, duplicate events are common, and polling a two-file directory is simpler and more deterministic.

On startup:

- Ensure the signal directory exists when control is enabled.
- Record the current `stop` file mtime, if present, so a stale file does not stop startup speech.
- Apply initial mute if either config/env says `startMuted` or the shared `mute` file exists.

During runtime:

- If `stop` mtime increases, call `commands.stop()`.
- If `mute` presence changes, call `commands.mute()` or `commands.unmute()`.

When the focused instance handles `F8`, it touches `stop` after stopping locally, causing other running instances to stop too. When it handles `F9`, it flips the `mute` file and applies the resulting state locally, causing other instances to sync on their next poll.

The signal bus returns a disposer that stops polling.

### Configuration

Extend `VoiceConfig` with:

```json
{
  "control": {
    "enabled": true,
    "signalDir": null,
    "pollMs": 200,
    "hotkeys": {
      "enabled": true,
      "stop": "f8",
      "muteToggle": "f9"
    }
  }
}
```

Validation rules:

- `control.enabled`: boolean, default `true`.
- `control.signalDir`: optional non-empty string.
- `control.pollMs`: integer, minimum `50`, default `200`.
- `control.hotkeys.enabled`: boolean, default `true`.
- `control.hotkeys.stop`: optional string, default `f8`.
- `control.hotkeys.muteToggle`: optional string, default `f9`.

If `control.enabled` is false, neither the hotkey listener nor signal bus starts. If `control.hotkeys.enabled` is false, the signal bus still starts so external or future internal publishers can control shared mute/stop state, but stdin hotkey listening is disabled.

### Plugin Wiring

Update `src/index.ts`:

- Build `commands` as today.
- Apply initial mute from `config.startMuted` and shared mute state before greeting.
- Start the signal bus and hotkey listener before speaking the greeting so `F8` can interrupt startup speech.
- Return a `dispose` hook that removes listeners and stops polling.
- Remove slash-command interception for `tui.command.execute` and `command.executed`.
- Remove `tool: { voice: ... }` from the returned hooks.

Keep `src/commands/index.ts`; it remains the internal control API used by greeting, hotkeys, and signal bus.

Delete or stop exporting:

- `src/tools/voice-tool.ts`
- `src/commands/shortcuts.ts`
- `src/commands/actions.ts`, unless a small action helper remains useful only internally

## Error Handling

Control startup failure must not disable speech. If the signal directory cannot be created or stdin listener setup fails, log a warning and continue without that control path.

Hotkey handlers must catch and log errors at the boundary. A failed control operation must not crash opencode.

Polling errors should be logged at warn level and retried on the next interval. Repeated missing directory errors should attempt to recreate the directory.

## Privacy and Safety

The listener observes raw stdin bytes, so it must stay minimal:

- Never log input chunks.
- Never buffer beyond the current chunk plus a small suffix needed for sequence matching.
- Never expose typed input through status or diagnostics.
- Never consume or modify input; opencode continues to receive the same data.

Function keys are preferred defaults because they are unlikely to overlap with normal prompt text. Users can disable hotkeys if their terminal sends sequences that conflict with opencode behavior.

## Documentation Changes

Update README controls section:

- Remove slash-command setup.
- Remove the `voice` tool section.
- Document default `F8` stop and `F9` mute toggle.
- Explain that the hotkeys work when the opencode terminal is focused.
- Explain that multiple running instances sync through the internal signal bus.
- Show configuration for changing or disabling hotkeys.
- Include a troubleshooting note for terminals that encode function keys differently and show how to set a literal sequence.

## Testing

Add unit tests for:

- Config defaults and overrides for `control`.
- Hotkey sequence matching for default `F8` and `F9` sequences.
- Hotkey listener using a fake readable stream; verify stop and mute handlers are called.
- Signal bus startup ignores stale `stop` file.
- Signal bus reacts to updated `stop` mtime.
- Signal bus applies `mute` presence changes.
- Disposers remove listeners and stop polling.
- Plugin index no longer returns `tool.voice` and includes `dispose` when control starts.

Remove or update tests for:

- `voice-tool.test.ts`
- `commands-shortcuts.test.ts`
- README expectations around slash commands, if any

Run verification:

- `npm test`
- `npm run typecheck`
- `npm run build`

## Non-Goals

- Global OS hotkeys while opencode is not focused.
- Registering custom opencode TUI keybinds from the plugin.
- Preserving the old slash commands.
- Preserving the old `voice` tool.
- Starting a local HTTP server.
- Requiring terminal, tmux, or OS-level keybinding configuration.
