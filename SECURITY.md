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
