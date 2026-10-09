/** Shared boundary utilities with no verifier/Host dependency. */

export type Credentials = { resolve?: (ref: string) => Promise<{ value?: string } | undefined> }

export async function resolveKey(credentials: Credentials | undefined, ref: string): Promise<string | undefined> {
  if (credentials?.resolve) {
    const resolved = await credentials.resolve(ref)
    if (resolved?.value) return resolved.value
  }
  return process.env[ref] || undefined
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

const SECRET_LITERAL_MIN_LENGTH = 8

/** Environment variable names that carry credentials. Shared by the check
 *  runner (such variables are withheld from candidate-controlled commands,
 *  review R1 1.2) and the egress redactor (their values are replaced wherever
 *  candidate output leaves the process, review R5 5.1). */
export const SECRET_ENV_NAME = /(?:^|_)(?:API_?KEYS?|KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASS|CREDENTIALS?|AUTH|PRIVATE)(?:_|$)/i

/**
 * Egress redaction policy (Phase 1): credentials must not leave the process
 * inside verifier prompts. Explicit literals (first and foremost the resolved
 * API key) are replaced before well-known token shapes are pattern-redacted.
 * Idempotent: '[REDACTED]' markers never match again.
 */
export function redactSecrets(text: string, extraLiterals: readonly string[] = []): string {
  let out = text
  for (const literal of extraLiterals) {
    if (typeof literal === 'string' && literal.length >= SECRET_LITERAL_MIN_LENGTH) {
      out = out.split(literal).join('[REDACTED]')
    }
  }
  return out
    .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[REDACTED-JWT]')
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9-]{14,}[A-Za-z0-9]\b/g, '[REDACTED-KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED-KEY]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, '[REDACTED-KEY]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED-KEY]')
    // `name = value` / `"name": "value"` where the name ends in a credential
    // word, including prefixed variable names (OPENAI_API_KEY=,
    // DATABASE_PASSWORD=, AWS_SECRET_ACCESS_KEY:, "client_secret":). The bare
    // keyword form missed every prefixed name, i.e. most `env` output
    // (review R5 5.1).
    .replace(
      /\b((?:Bearer\s+)|(?:[A-Za-z0-9_]*?(?:token|password|passwd|secret|api[-_]?key|access[-_]?key)["']?\s*[:=]\s*))(["']?)([A-Za-z0-9._+/=-]{16,})(["']?)/gi,
      (_match, prefix: string, opening: string, _value: string, closing: string) =>
        prefix + opening + '[REDACTED]' + (closing === opening ? closing : ''),
    )
}

/** Review R1 (1.2): a copy of `env` without credential-shaped variables and
 *  without the explicitly named ones (the configured verifier key). Objective
 *  checks and the post-audit execute candidate-authored code (`npm test` runs
 *  whatever tests the candidate wrote), so they must not inherit the Host's
 *  provider keys. PATH, HOME, locale, proxy, and toolchain variables stay. */
export function scrubSecretEnv(extraNames: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const explicit = new Set(extraNames.filter(name => typeof name === 'string' && name).map(name => name.toUpperCase()))
  const out: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (explicit.has(name.toUpperCase()) || SECRET_ENV_NAME.test(name)) continue
    out[name] = value
  }
  return out
}

/** Literal values to redact for one egress context: the given credentials
 *  (first and foremost the resolved verifier key) plus the value of every
 *  credential-named variable in `env`. Longest first, so a value that
 *  contains another is replaced whole. */
export function secretLiterals(explicit: ReadonlyArray<string | undefined | null>, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>()
  for (const value of explicit) if (typeof value === 'string' && value.length >= SECRET_LITERAL_MIN_LENGTH) out.add(value)
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length >= SECRET_LITERAL_MIN_LENGTH && SECRET_ENV_NAME.test(name)) out.add(value)
  }
  return [...out].sort((a, b) => b.length - a.length)
}

/** One redaction policy for a whole egress context (review R5 5.1): literals
 *  are collected once, then every text that leaves goes through the same
 *  literal + pattern pass the legacy lane prompt always had. */
export function makeRedactor(explicit: ReadonlyArray<string | undefined | null>, env: NodeJS.ProcessEnv = process.env): (text: string) => string {
  const literals = secretLiterals(explicit, env)
  return (text: string) => redactSecrets(text, literals)
}

/** Pattern redaction plus the literal values of credential-named environment
 *  variables, for egress that has no request-specific key at hand
 *  (diagnostics, HTTP error bodies). */
export function redactWithEnvSecrets(text: string): string {
  return redactSecrets(text, secretLiterals([]))
}
