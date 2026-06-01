# Design: Publishing `opencode-speaker` 1.0.0 to npm

**Date:** 2026-06-01
**Status:** Approved (pending spec review)

## Goal

Publish the `opencode-speaker` opencode plugin as a public npm package at version
`1.0.0`, with a reproducible release pipeline: CI gates every change, releases are
triggered by git tags, the published tarball carries an npm provenance attestation,
and each release has a matching GitHub Release.

## Context (current state, 2026-06-01)

- Repo: `git@github.com:herquiloidehele/opencode-speaker.git`
  (owner `herquiloidehele`, repo `opencode-speaker`,
  URL `https://github.com/herquiloidehele/opencode-speaker`).
- Package name `opencode-speaker` is **available** on the npm registry (404 today).
- `package.json` is at `version: 0.2.0`, `type: module`, ESM-only, built with `tsup`
  (entries `src/index.ts`, `src/api.ts`; `dts: true`, `clean: true`). `files` whitelist
  is `["dist", "README.md"]`. `license: MIT` declared.
- `npm run typecheck` passes. `npm pack --dry-run` produces a clean 6-file tarball
  (README.md, dist/api.d.ts, dist/api.js, dist/index.d.ts, dist/index.js, package.json).
- `npm test` **fails: 2 of 206 tests** (details in Workstream A).
- Not logged into npm (`npm whoami` → ENEEDAUTH). No CI/CD. No LICENSE file.
- `.DS_Store` is tracked in git (currently staged). `docs/` is gitignored.
- There is a staged, uncommitted edit to `src/handlers/narrator.ts`.

## Decisions (approved)

- First published version: **1.0.0**.
- Scope of go-live: **full release pipeline** — npm publish + CI + automated
  publish-on-tag + provenance + GitHub Release + CHANGELOG.
- Publish method: **automated via GitHub Actions** using **npm Trusted Publishing
  (OIDC)** as the primary auth model; stored `NPM_TOKEN` automation secret is the
  documented fallback.
- `engines`: `node >=20` (advisory; matches `@types/node ^20`).
- CI matrix: Node 20 + 22 on `ubuntu-latest` only (audio runner is mocked in tests).
- One manual **bootstrap** publish of 1.0.0 to create the package + establish trusted
  publishing, then all subsequent releases are tag-driven and tokenless.
- The GitHub repo must be **public** (required for free provenance + trusted
  publishing). User confirmed this is acceptable.

---

## Workstream A — Quality gate

Nothing ships while `npm test` or `npm run typecheck` is red. Reconcile the working
tree first, then fix the two failing tests.

1. **Reconcile working tree** — inspect the staged `src/handlers/narrator.ts` diff and
   the staged `.DS_Store`. Decide what to keep before making further changes.
2. **Stale `voice` custom-tool test** (`test/index.test.ts`, "registers a `voice` custom
   tool") — the "remove voice commands" commits dropped `tool.voice`; `index.ts` now
   returns only `{ event }`. **Fix:** delete the test. Grep the test suite for any other
   assertions referencing a removed `tool`/`voice` hook surface and remove those too.
3. **Narrator truncation test** (`test/handlers-narrator.test.ts`, "truncates very long
   assistant text in the prompt") — feeds 10,000 chars of assistant text and asserts the
   serialized prompt is `< 5000` chars; this now fails because the narrator no longer
   caps assistant text. **Resolution (default: restore truncation):** re-introduce an
   assistant-text length cap in `src/handlers/narrator.ts` so prompts stay bounded and
   cheap. If reading the staged diff shows truncation was removed deliberately, instead
   update the test to assert the new intended bound. Pick one and make the test reflect
   reality.

**Exit criteria:** `npm run typecheck` green, `npm test` green (all tests pass),
`npm audit --omit=dev` clean.

---

## Workstream B — Package metadata & build correctness

4. **`LICENSE`** — add MIT license text, `Copyright (c) 2026 herquiloide`
   (derived from git config; adjust to your preferred legal name/handle).
5. **`package.json` edits:**
   - `version` → `1.0.0`.
   - `repository` → `{ "type": "git", "url": "git+https://github.com/herquiloidehele/opencode-speaker.git" }`.
   - `bugs` → `{ "url": "https://github.com/herquiloidehele/opencode-speaker/issues" }`.
   - `homepage` → `https://github.com/herquiloidehele/opencode-speaker#readme`.
   - `author` → `herquiloide <herquiloide@gmail.com>` (adjust as preferred).
   - `keywords` → `["opencode", "plugin", "tts", "text-to-speech", "elevenlabs", "openai", "anthropic", "voice", "ai-sdk"]`.
   - `engines` → `{ "node": ">=20" }`.
   - `publishConfig` → `{ "access": "public", "provenance": true }`.
6. **Build-before-publish hook** — `dist/` is gitignored, so a clean-checkout publish
   would ship no build. Add `"prepublishOnly": "npm run typecheck && npm test && npm run build"`.
   (The release workflow also builds explicitly; this is defense in depth.)
7. **Tarball verification** — after adding LICENSE, run `npm pack --dry-run` and confirm
   contents: README.md, LICENSE, dist/*, package.json. Keep `files` as
   `["dist", "README.md"]` (npm always includes LICENSE automatically).

---

## Workstream C — Repo hygiene

8. **Untrack `.DS_Store`** — `git rm --cached .DS_Store`; ensure `.DS_Store` is in
   `.gitignore` (it is not currently). Recommend a global gitignore for `.DS_Store`.
9. **`.gitignore` adjustment** — `docs/` is fully ignored, but design specs and
   implementation plans live under `docs/superpowers/`. Un-ignore `docs/superpowers/`
   (e.g. `docs/` + `!docs/superpowers/`) so this spec and the plan are version-controlled;
   keep the rest of `docs/` ignored.
10. **Secrets check** — confirm `.claude/settings.local.json` and `.idea/` remain
    untracked (verified today). No API keys anywhere in the repo.

---

## Workstream D — Documentation

11. **README polish** — add an npm version badge and a license badge near the top; add a
    one-line "Requirements" note (Node ≥20; OS audio dependencies are already covered in
    Troubleshooting). Install instructions already use the published name.
12. **`CHANGELOG.md`** — Keep-a-Changelog format with a `1.0.0` entry describing the
    initial public release (features: pluggable TTS via OpenAI/ElevenLabs, narrator via
    OpenAI/Anthropic, event catalog, verbosity profiles, greeting).
13. **`CONTRIBUTING.md`** — dev setup, `npm test` / `npm run typecheck` / `npm run build`,
    the six demo scripts, and the release process (tag `v*` → CI publishes).
14. **`SECURITY.md`** — API-key handling (env vars only, never logged) and how to report
    vulnerabilities.

---

## Workstream E — CI/CD (GitHub Actions)

15. **`.github/workflows/ci.yml`** — triggers on push and pull_request. Steps:
    `actions/checkout`, `actions/setup-node` (matrix Node `20` and `22`, `ubuntu-latest`),
    `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm audit --omit=dev`.
16. **`.github/workflows/release.yml`** — triggers on tag push `v*.*.*`. Permissions
    `id-token: write` (OIDC provenance) and `contents: write` (GitHub Release). Steps:
    `checkout`, `setup-node` (with `registry-url: https://registry.npmjs.org`),
    `npm ci`, `typecheck`, `test`, `build`, `npm publish` (provenance enabled via
    `publishConfig` / `--provenance`), then create a GitHub Release with notes pulled
    from `CHANGELOG.md`.
17. **Auth model** — **npm Trusted Publishing (OIDC)**: configure the trusted publisher
    on npmjs.com (org `herquiloidehele`, repo `opencode-speaker`, workflow
    `release.yml`). No stored token; provenance is automatic. **Precondition: repo is
    public.** Documented fallback: granular `NPM_TOKEN` automation secret +
    `npm publish --provenance` if trusted-publishing config is deferred.
18. **Release runbook** — `npm version 1.0.0` (creates commit + tag) → `git push --follow-tags`
    → release workflow runs → package on npm + GitHub Release created.

---

## Workstream F — npm account & first-publish runbook

19. **Account prep** — log in to npm (`npm login`), enable 2FA. Confirm unscoped name
    `opencode-speaker` (available, chosen).
20. **Bootstrap publish** — because trusted-publishing setup on npmjs.com requires the
    package to already exist, do one initial manual `npm publish` of `1.0.0` (with
    provenance), then configure OIDC trusted publishing so all future tag-driven releases
    are tokenless.
21. **Post-publish smoke test** — `npm view opencode-speaker`; in a throwaway opencode
    config (`"plugin": ["opencode-speaker"]`) with `OPENAI_API_KEY` set, launch opencode
    and confirm the startup greeting plays. Optionally install the packed tarball
    (`npm pack` → install the `.tgz`) before the real publish as an extra check.
22. **Ecosystem (optional)** — announce / list the plugin in the opencode plugin community
    or directory if one exists.

---

## Out of scope

- Adding new plugin features or providers (runtime custom-provider registration stays a
  future item, as the README already notes).
- Multi-OS or audio-hardware CI (tests mock the audio runner).
- Monorepo / multiple package extraction.

## Risks & mitigations

- **Clean-checkout publishes an empty `dist/`** → mitigated by `prepublishOnly` build and
  an explicit build step in the release workflow.
- **Provenance/OIDC requires a public repo** → confirmed acceptable; `NPM_TOKEN` fallback
  documented if that changes.
- **Trusted publishing needs the package to pre-exist** → mitigated by the one-time
  bootstrap publish.
- **Narrator truncation regression** → resolved explicitly in Workstream A so the
  published behavior is intentional, not accidental.
