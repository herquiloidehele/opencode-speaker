const ENV_VAR_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  elevenlabs: "ELEVENLABS_API_KEY",
}

export function requiredEnvVar(slug: string): string | null {
  const slash = slug.indexOf("/")
  if (slash <= 0) return null
  const provider = slug.slice(0, slash)
  return ENV_VAR_BY_PROVIDER[provider] ?? null
}

export interface CredentialCheck {
  narratorSlug: string
  ttsSlug: string
}

export type CredentialResult =
  | { ok: true }
  | { ok: false; missing: string[] }

export function checkCredentials(
  check: CredentialCheck,
  env: Record<string, string | undefined>,
): CredentialResult {
  const required = new Set<string>()
  for (const slug of [check.narratorSlug, check.ttsSlug]) {
    const v = requiredEnvVar(slug)
    if (v) required.add(v)
  }
  const missing: string[] = []
  for (const name of required) {
    const val = env[name]
    if (val === undefined || val.trim().length === 0) missing.push(name)
  }
  missing.sort()
  return missing.length === 0 ? { ok: true } : { ok: false, missing }
}
