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
    .replace(
      /\b((?:Bearer\s+)|(?:(?:token|password|passwd|secret|api[-_]?key)\s*[:=]\s*))(["']?)([A-Za-z0-9._+/=-]{16,})(["']?)/gi,
      (_match, prefix: string, opening: string, _value: string, closing: string) =>
        prefix + opening + '[REDACTED]' + (closing === opening ? closing : ''),
    )
}
