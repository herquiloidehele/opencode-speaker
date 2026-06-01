# npm Publish Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `opencode-speaker@1.0.0` as a public npm package with a green test suite, complete package metadata, repo hygiene, docs, and a GitHub Actions CI + tag-driven release pipeline that publishes with npm provenance.

**Architecture:** Tasks 1–2 turn the test suite green (the gate everything else keys off). Tasks 3–5 fix the package manifest, license, and repo hygiene so the tarball is correct and reproducible. Tasks 6–8 add user/maintainer docs. Tasks 9–10 add CI and the tag-triggered release workflow. The final **Release Runbook** section lists the one-time manual operator steps (npm account, public repo, bootstrap publish, trusted-publishing config, smoke test) that require credentials and so can't be scripted in this plan.

**Tech Stack:** TypeScript (ESM), tsup (build), Vitest (tests), GitHub Actions, npm registry with OIDC Trusted Publishing + provenance.

**Spec:** [docs/superpowers/specs/2026-06-01-npm-publish-go-live-design.md](../specs/2026-06-01-npm-publish-go-live-design.md)

**Conventions for every commit in this plan:** end the commit message body with the trailer:
```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```
All work happens on the existing branch `chore/npm-publish-go-live`.

---

## Task 1: Restore narrator assistant-text truncation cap

The narrator caps assistant text at `truncate(ctx.assistantText, 10000)`, but the dispatcher already bounds it to `textWindow` (4000) and the test feeds 10,000 chars expecting truncation. Align the narrator's safety-net cap to the dispatcher window (4000) so very long text is actually truncated, and make the test assert that bound robustly.

**Files:**
- Modify: `src/handlers/narrator.ts:61-67`
- Test: `test/handlers-narrator.test.ts:131-142`

- [ ] **Step 1: Update the failing test to assert the truncation bound**

In `test/handlers-narrator.test.ts`, replace the existing test body (lines 131–142):

```ts
  it("truncates very long assistant text in the prompt", async () => {
    let capturedPrompt = ""
    const { model } = mockModel("ok", {
      onCall: (input) => {
        capturedPrompt = JSON.stringify(input)
      },
    })
    const n = createNarrator(model, baseConfig)
    const long = "x".repeat(10_000)
    await n.summarize({ type: "session.idle" }, ctx(long))
    expect(capturedPrompt.length).toBeLessThan(5000)
  })
```

with:

```ts
  it("truncates very long assistant text in the prompt", async () => {
    let capturedPrompt = ""
    const { model } = mockModel("ok", {
      onCall: (input) => {
        capturedPrompt = JSON.stringify(input)
      },
    })
    const n = createNarrator(model, baseConfig)
    const long = "x".repeat(10_000)
    await n.summarize({ type: "session.idle" }, ctx(long))
    // The narrator caps assistant text at the dispatcher's text window (4000),
    // so the raw 10k-char input must not reach the model verbatim.
    const xRun = capturedPrompt.match(/x+/)?.[0] ?? ""
    expect(xRun.length).toBeGreaterThan(0)
    expect(xRun.length).toBeLessThanOrEqual(4000)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/handlers-narrator.test.ts -t "truncates very long assistant text"`
Expected: FAIL — the captured `x` run is 10000 (no truncation), so `10000  toBeLessThanOrEqual 4000` fails.

- [ ] **Step 3: Lower the narrator cap to the dispatcher window**

In `src/handlers/narrator.ts`, change the `buildContext` cap (currently lines 61–67). Replace:

```ts
function buildContext(
  event: { type: string; [k: string]: unknown },
  ctx: NarrationContext,
): string {
  // The dispatcher already bounds assistantText to its textWindow (4000), but
  // the narrator can be called directly (tests, demo scripts), so cap here too.
  const text = truncate(ctx.assistantText, 10000)
```

with:

```ts
// The dispatcher already bounds assistantText to its textWindow (4000) before
// it reaches us, but the narrator can also be called directly (tests, demo
// scripts), so cap here too as a safety net at the same bound. Keeps the
// narration prompt cheap and bounded.
const MAX_ASSISTANT_TEXT = 4000

function buildContext(
  event: { type: string; [k: string]: unknown },
  ctx: NarrationContext,
): string {
  const text = truncate(ctx.assistantText, MAX_ASSISTANT_TEXT)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/handlers-narrator.test.ts -t "truncates very long assistant text"`
Expected: PASS — `truncate` returns 4000 `x`s plus `…`, so the `x` run is exactly 4000.

- [ ] **Step 5: Commit**

```bash
git add src/handlers/narrator.ts test/handlers-narrator.test.ts
git commit -m "fix: cap narrator assistant text at dispatcher window (4000)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Remove the stale `voice` custom-tool test

The "remove voice commands" commits dropped the `voice` custom tool from the plugin's returned hooks — `src/index.ts` now returns only `{ event }`. One test still asserts `hooks.tool?.voice` is defined and fails. Delete it. This is the last failing test, so verify the whole suite goes green here.

**Files:**
- Modify: `test/index.test.ts:70-74`

- [ ] **Step 1: Delete the stale test**

In `test/index.test.ts`, delete this block (lines 70–74):

```ts
  it("registers a `voice` custom tool", async () => {
    const { ctx } = baseCtx()
    const hooks = (await OpencodeSpeaker(ctx, {})) as any
    expect(hooks.tool?.voice).toBeDefined()
  })
```

(Remove the whole `it(...)` call, including its trailing blank line so two blank lines don't remain.)

- [ ] **Step 2: Run the full suite to verify everything is green**

Run: `npm test`
Expected: PASS — all test files pass, 0 failures (was 2 failed / 204 passed; now 0 failed).

- [ ] **Step 3: Run typecheck and the production audit**

Run: `npm run typecheck && npm run audit:prod`
Expected: typecheck exits 0; `npm audit --omit=dev` reports `found 0 vulnerabilities` (if it reports vulnerabilities, stop and report them — do not silently ignore).

- [ ] **Step 4: Commit**

```bash
git add test/index.test.ts
git commit -m "test: drop stale voice custom-tool assertion

The voice custom tool was removed; the plugin now returns only an event
hook. This was the last failing test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Add the LICENSE file

`package.json` declares `"license": "MIT"` but no `LICENSE` file exists. npm auto-includes a `LICENSE` file in the published tarball.

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create `LICENSE`**

```
MIT License

Copyright (c) 2026 herquiloide

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(Adjust `herquiloide` to your preferred legal name/handle if desired.)

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -m "chore: add MIT LICENSE file

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Complete package.json metadata + prepublishOnly hook

Add the registry-facing metadata (`repository`, `bugs`, `homepage`, `author`, `keywords`, `engines`, `publishConfig`), bump to `1.0.0`, and add a `prepublishOnly` build/test gate so a clean-checkout publish can never ship a missing or stale `dist/`.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace package.json with the complete manifest**

Write `package.json` with exactly this content:

```json
{
  "name": "opencode-speaker",
  "version": "1.0.0",
  "description": "Speaker plugin for opencode — speaks agent events through pluggable TTS backends.",
  "keywords": [
    "opencode",
    "plugin",
    "tts",
    "text-to-speech",
    "elevenlabs",
    "openai",
    "anthropic",
    "voice",
    "ai-sdk"
  ],
  "homepage": "https://github.com/herquiloidehele/opencode-speaker#readme",
  "bugs": {
    "url": "https://github.com/herquiloidehele/opencode-speaker/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/herquiloidehele/opencode-speaker.git"
  },
  "license": "MIT",
  "author": "herquiloide <herquiloide@gmail.com>",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./api": {
      "import": "./dist/api.js",
      "types": "./dist/api.d.ts"
    }
  },
  "files": [
    "dist",
    "README.md"
  ],
  "engines": {
    "node": ">=20"
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "logs": "bash scripts/logs.sh",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "audit:prod": "npm audit --omit=dev",
    "prepublishOnly": "npm run typecheck && npm test && npm run build",
    "demo:say": "tsx scripts/say.ts",
    "demo:queue": "tsx scripts/queue.ts",
    "demo:event": "tsx scripts/event.ts",
    "demo:narrator": "tsx scripts/narrator.ts",
    "demo:config": "tsx scripts/config.ts",
    "demo:greet": "tsx scripts/greet.ts"
  },
  "dependencies": {
    "@ai-sdk/anthropic": "^2.0.79",
    "@ai-sdk/elevenlabs": "^1.0.28",
    "@ai-sdk/openai": "^2.0.106",
    "ai": "^5.0.192",
    "source-map-support": "^0.5.21",
    "zod": "^3.23.0"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  },
  "peerDependenciesMeta": {
    "@opencode-ai/plugin": {
      "optional": true
    }
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/source-map-support": "^0.5.10",
    "msw": "^2.14.6",
    "tsup": "^8.0.0",
    "tsx": "^4.22.3",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Verify the manifest is valid JSON and the version is 1.0.0**

Run: `node -e "const p=require('./package.json'); console.log(p.name, p.version, p.engines.node, p.publishConfig.access)"`
Expected: `opencode-speaker 1.0.0 >=20 public`

- [ ] **Step 3: Build, then verify the publish tarball contents**

Run: `npm run build && npm pack --dry-run`
Expected: tarball lists `LICENSE`, `README.md`, `dist/api.d.ts`, `dist/api.js`, `dist/index.d.ts`, `dist/index.js`, `package.json` — 7 files, `version: 1.0.0`.

- [ ] **Step 4: Confirm LICENSE is in the tarball**

Run: `npm pack --dry-run 2>&1 | grep -i license`
Expected: a line referencing `LICENSE`.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "chore: complete npm metadata, bump to 1.0.0, add prepublishOnly

Adds repository/bugs/homepage/author/keywords/engines/publishConfig and a
prepublishOnly build+test gate so a clean checkout never ships a stale dist.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Repo hygiene — untrack .DS_Store, fix .gitignore

`.DS_Store` is tracked (staged) and must not ship in git. Also un-ignore `docs/superpowers/` so design specs and plans are version-controlled while the rest of `docs/` stays ignored.

**Files:**
- Modify: `.gitignore`
- Remove from git: `.DS_Store`

- [ ] **Step 1: Replace `.gitignore`**

Write `.gitignore` with exactly this content:

```
node_modules/
dist/
.opencode/
.idea/
*.log
.DS_Store
docs/*
!docs/superpowers/
```

- [ ] **Step 2: Untrack `.DS_Store`**

Run: `git rm --cached .DS_Store`
Expected: `rm '.DS_Store'`

- [ ] **Step 3: Verify `.DS_Store` is no longer tracked and `docs/superpowers/` is**

Run: `git ls-files | grep -E 'DS_Store|docs/superpowers' || echo "no DS_Store; check docs below"; git check-ignore -v docs/superpowers/specs/2026-06-01-npm-publish-go-live-design.md; echo "exit=$?"`
Expected: no `.DS_Store` line; the spec file is **not** ignored (`git check-ignore` prints nothing and `exit=1`).

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: stop tracking .DS_Store; version-control docs/superpowers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: README badges + Requirements section

Add npm/CI/license badges and a short Requirements note. The install instructions already use the published name, so no change there.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Insert badges after the H1**

Replace:

```markdown
# opencode-speaker

A speaker plugin for [opencode](https://opencode.ai) that **speaks agent activity out loud** through pluggable text-to-speech backends.
```

with:

```markdown
# opencode-speaker

[![npm version](https://img.shields.io/npm/v/opencode-speaker.svg)](https://www.npmjs.com/package/opencode-speaker)
[![CI](https://github.com/herquiloidehele/opencode-speaker/actions/workflows/ci.yml/badge.svg)](https://github.com/herquiloidehele/opencode-speaker/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A speaker plugin for [opencode](https://opencode.ai) that **speaks agent activity out loud** through pluggable text-to-speech backends.
```

- [ ] **Step 2: Insert a Requirements section before Install**

Replace:

```markdown
Powered by the [Vercel AI SDK](https://sdk.vercel.ai).

---

## Install
```

with:

```markdown
Powered by the [Vercel AI SDK](https://sdk.vercel.ai).

---

## Requirements

- **Node.js ≥ 20**
- An API key for your chosen provider (OpenAI by default; ElevenLabs and/or Anthropic optional)
- On Linux, a TTS/audio backend — see [Troubleshooting](#troubleshooting)

---

## Install
```

- [ ] **Step 3: Verify the edits applied**

Run: `grep -c "img.shields.io" README.md; grep -c "## Requirements" README.md`
Expected: `3` then `1`.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add badges and a Requirements section to README

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Add CHANGELOG.md

**Files:**
- Create: `CHANGELOG.md`

- [ ] **Step 1: Create `CHANGELOG.md`**

```markdown
# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-01

### Added
- Initial public release.
- Speaks opencode agent activity out loud through pluggable text-to-speech backends.
- TTS providers: OpenAI (default) and ElevenLabs.
- LLM narrator providers: OpenAI and Anthropic, via the Vercel AI SDK.
- Event catalog with per-event modes (`template`, `narrate`, `verbatim`) and
  verbosity profiles (`minimal`, `normal`, `verbose`).
- Configurable startup greeting, mute / start-muted controls, and rate-limited narration.
- Graceful degradation: the plugin disables itself with a toast instead of crashing
  opencode on misconfiguration or missing credentials.

[1.0.0]: https://github.com/herquiloidehele/opencode-speaker/releases/tag/v1.0.0
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add CHANGELOG with 1.0.0 entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Add CONTRIBUTING.md and SECURITY.md

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`

- [ ] **Step 1: Create `CONTRIBUTING.md`**

````markdown
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
````

- [ ] **Step 2: Create `SECURITY.md`**

```markdown
# Security Policy

## API keys and secrets

opencode-speaker reads provider credentials (`OPENAI_API_KEY`,
`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`) exclusively from environment
variables. Keys are never written to disk, never logged, and never sent
anywhere except the corresponding provider's official API endpoint via the
Vercel AI SDK.

Do not place API keys in `opencode.json` or any file committed to source
control — use environment variables.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories:
https://github.com/herquiloidehele/opencode-speaker/security/advisories/new

If you cannot use that, open a minimal issue asking a maintainer to make
contact — do not include exploit details in a public issue.

We aim to acknowledge reports within 7 days.
```

- [ ] **Step 3: Commit**

```bash
git add CONTRIBUTING.md SECURITY.md
git commit -m "docs: add CONTRIBUTING and SECURITY policy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Add the CI workflow

Runs on push to `main` and on every PR: install, typecheck, test, build, prod-audit, across Node 20 and 22 on Ubuntu (the audio runner is mocked in tests, so no audio hardware is needed).

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      # Informational: surfaces prod-dependency advisories without blocking
      # merges on unrelated upstream CVEs. Remove continue-on-error to gate.
      - run: npm run audit:prod
        continue-on-error: true
```

- [ ] **Step 2: Validate the YAML parses**

Run: `npx --yes js-yaml .github/workflows/ci.yml > /dev/null && echo "valid yaml"`
Expected: `valid yaml` (non-zero exit + error text means a syntax problem to fix).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions CI (typecheck/test/build on Node 20 & 22)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Add the tag-triggered release workflow

On a `v*.*.*` tag push: install, typecheck, test, build, `npm publish` with provenance via OIDC Trusted Publishing (no stored token), then create a GitHub Release. Includes a commented `NPM_TOKEN` fallback.

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags: ['v*.*.*']

permissions:
  contents: write   # create the GitHub Release
  id-token: write   # OIDC: npm provenance + Trusted Publishing

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: 'https://registry.npmjs.org'
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      # Ensure an npm version that supports OIDC Trusted Publishing.
      - run: npm install -g npm@latest
      # Publishes with provenance (publishConfig.provenance=true). With Trusted
      # Publishing configured for this package on npmjs.com, no token is needed.
      - run: npm publish
        # --- NPM_TOKEN fallback (if NOT using Trusted Publishing) ---
        # Replace the line above with:
        #   run: npm publish --provenance
        # and uncomment:
        # env:
        #   NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
```

- [ ] **Step 2: Validate the YAML parses**

Run: `npx --yes js-yaml .github/workflows/release.yml > /dev/null && echo "valid yaml"`
Expected: `valid yaml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered release workflow with npm provenance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: Final verification + push the branch

- [ ] **Step 1: Re-run the full gate from a clean state**

Run: `rm -rf dist && npm ci && npm run typecheck && npm test && npm run build && npm pack --dry-run`
Expected: typecheck exits 0; all tests pass, 0 failures; build succeeds; tarball lists 7 files (`LICENSE`, `README.md`, `dist/*` ×4, `package.json`) at `version: 1.0.0`.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin chore/npm-publish-go-live
```

- [ ] **Step 3: Open a PR (optional, recommended)**

Use the `superpowers:finishing-a-development-branch` skill to open a PR into `main`, or merge directly if you prefer. CI must be green before merge.

---

## Release Runbook (one-time manual operator steps)

These steps require npm credentials, GitHub repo settings, and a live registry, so they are **not** automated by this plan. Do them once, in order, after the branch is merged to `main` and CI is green.

- [ ] **1. Make the GitHub repo public.** Settings → General → Danger Zone → Change visibility → Public. **Required** — npm provenance and free Trusted Publishing only work for public repos. (If you must keep it private, use the `NPM_TOKEN` fallback in `release.yml` and drop provenance.)

- [ ] **2. Prepare the npm account.** Create/sign in to an npm account that owns the name `opencode-speaker` (the name is currently unregistered/available). Enable 2FA (Account → Two-Factor Authentication).

- [ ] **3. Bootstrap-publish 1.0.0 (creates the package).** From a clean checkout of `main`:
  ```bash
  npm login
  git checkout main && git pull
  npm ci
  npm publish --provenance=false --access public
  ```
  > `--provenance=false` overrides `publishConfig.provenance` for this one local publish — npm can only generate provenance from a supported CI/OIDC environment, so a local publish with provenance enabled would error. This first release therefore has no provenance attestation; all subsequent CI releases do.
  >
  > **Alternative (no bootstrap):** if you'd rather the very first release carry provenance, skip this step, configure Trusted Publishing (step 4) for the not-yet-existing package, then jump to step 6 and tag `v1.0.0` so CI performs the initial publish. Use this only if npm lets you register a trusted publisher for a package that doesn't exist yet; otherwise do the bootstrap above.

- [ ] **4. Configure npm Trusted Publishing.** On npmjs.com → the `opencode-speaker` package → Settings → Trusted Publisher → GitHub Actions. Set: organization/user `herquiloidehele`, repository `opencode-speaker`, workflow filename `release.yml`. (Leave environment blank unless you add one to the workflow.) This lets the release workflow publish tokenlessly with provenance.

- [ ] **5. Verify the bootstrap publish.**
  ```bash
  npm view opencode-speaker version   # → 1.0.0
  ```

- [ ] **6. Smoke-test the published package.** In a throwaway directory:
  ```bash
  mkdir /tmp/ocs-smoke && cd /tmp/ocs-smoke
  printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["opencode-speaker"]\n}\n' > opencode.json
  export OPENAI_API_KEY=sk-...   # a real key
  opencode   # launch; confirm you hear the startup greeting, then quit
  ```
  Expected: opencode loads the plugin and speaks "Welcome to OpenCode Speaker!".

- [ ] **7. Cut future releases via CI.** From `main`:
  ```bash
  npm version <patch|minor|major>   # e.g. 1.0.1 / 1.1.0 / 2.0.0
  git push --follow-tags
  ```
  The release workflow type-checks, tests, builds, publishes to npm **with provenance**, and creates a GitHub Release. Verify with `npm view opencode-speaker version` and the repo's Releases page.

- [ ] **8. (Optional) Announce / list** the plugin in the opencode plugin community or directory.

---

## Notes / decisions baked into this plan
- **Narrator cap = 4000** (matches the dispatcher's `textWindow`); a tighter value would also pass the test but 4000 keeps production behavior unchanged while making truncation meaningful.
- **Audit is non-gating in CI** (`continue-on-error: true`) to avoid blocking merges on unrelated upstream advisories; it still runs as the local quality gate (Task 2) and in CI for visibility. Flip it to gating by removing that line.
- **Bootstrap publish is local and provenance-free**; provenance applies to every CI release thereafter. This corrects a detail in the spec (the spec said the bootstrap publish would carry provenance, which npm does not support outside CI).
- **Repo must be public** for the provenance/OIDC path; the `NPM_TOKEN` fallback is wired (commented) in `release.yml` if that changes.
