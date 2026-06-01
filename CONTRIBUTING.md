# Contributing

Thanks for your interest in improving opencode-speaker!

## Development setup

```bash
git clone https://github.com/herquiloidehele/opencode-speaker.git
cd opencode-speaker
npm install
```

## Common commands

| Command | What it does |
|---|---|
| `npm test` | Run the full unit + integration suite (Vitest). |
| `npm run typecheck` | Type-check with `tsc --noEmit`. |
| `npm run build` | Produce `dist/` with tsup. |
| `npm run audit:prod` | Audit production dependencies. |

## Demo scripts

Six scripts exercise features without booting opencode (all use `tsx`):

```bash
npm run demo:say -- "hello world"
npm run demo:queue
npm run demo:event -- session.idle
npm run demo:narrator -- --assistant-text="..." --tool=bash
npm run demo:config -- '{"verbosity":"minimal"}'
npm run demo:greet
```

## Pull requests

1. Branch from `main`.
2. Add or update tests for your change.
3. Make sure `npm run typecheck` and `npm test` pass.
4. Open a PR. CI runs typecheck, tests, build, and a production audit on Node 20 and 22.

## Releasing (maintainers)

Releases are automated by `.github/workflows/release.yml` on tag push:

```bash
npm version <patch|minor|major>   # bumps package.json, creates a commit + tag
git push --follow-tags
```

The workflow type-checks, tests, builds, and publishes to npm with provenance,
then creates a GitHub Release.
