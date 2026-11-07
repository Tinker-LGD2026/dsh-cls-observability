/**
 * Secret redaction for captured content (messages, tool arguments and results, system
 * instructions). Runs before truncation, so a cut never exposes part of a secret.
 *
 * Built-in rules target formats with a recognisable shape (few false positives) plus
 * `key = value` assignments whose key names a credential. Values under credential-named
 * keys in structured tool arguments are masked whole. Customers can add patterns.
 */

export interface RedactionRule {
  name: string
  pattern: RegExp
  /** Replacement; `$<keep>` keeps a named group (e.g. the key of an assignment). */
  replace: string
}

const mask = (name: string) => `[REDACTED:${name}]`

/** Credential-like key names (assignments, headers, JSON keys). */
const SECRET_KEY = String.raw`(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|secret[_-]?key|secret[_-]?id|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|session[_-]?token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)`
const SECRET_KEY_RE = new RegExp(`^${SECRET_KEY}$`, 'i')

export const BUILTIN_RULES: readonly RedactionRule[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: mask('private_key'),
  },
  { name: 'tencentcloud_secret_id', pattern: /\bAKID[0-9A-Za-z]{13,40}\b/g, replace: mask('tencentcloud_secret_id') },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: mask('aws_access_key') },
  { name: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replace: mask('github_token') },
  { name: 'gitlab_token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: mask('gitlab_token') },
  { name: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: mask('slack_token') },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: mask('google_api_key') },
  { name: 'api_key', pattern: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g, replace: mask('api_key') },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: mask('jwt') },
  {
    name: 'authorization',
    pattern: /\b(?<keep>(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{16,}/g,
    replace: `$<keep>${mask('authorization')}`,
  },
  {
    name: 'url_credentials',
    pattern: /\b(?<keep>[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
    replace: `$<keep>${mask('url_credentials')}`,
  },
  {
    // KEY=value, "key": "value", key: value — keep the key, mask the value. The value must
    // be a literal: not a call (`getToken()`), a property reference (`config.password`),
    // an indexed lookup, or an empty-value keyword.
    name: 'assignment',
    pattern: new RegExp(
      String.raw`(?<keep>["']?\b${SECRET_KEY}\b["']?\s*[:=]\s*["']?)`
        + String.raw`(?!\[REDACTED)(?!(?:undefined|null|true|false|none|nil|empty|required|optional|string|number|boolean|unknown|object)\b)`
        + String.raw`(?![A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?=[\s"',;}{)\]]|$))`
        // A type name in a declaration (`token: PtcPermitToken;`), not a secret. Case-sensitive
        // even though the rule as a whole is not.
        + String.raw`(?!(?-i:(?:[A-Z][a-z]+){2,})(?=[\s"',;}{)\]|<>?]|$))`
        + String.raw`[^\s"',;}{)(\[\]]{6,}(?=[\s"',;}{)\]]|$)`,
      'gi',
    ),
    replace: `$<keep>${mask('assignment')}`,
  },
]

export class Redactor {
  private readonly rules: readonly RedactionRule[]

  constructor(rules: readonly RedactionRule[]) {
    this.rules = rules
  }

  /** Redact one string; records the rule names that matched into `hits`. */
  text(value: string, hits: Set<string>): string {
    let out = value
    for (const rule of this.rules) {
      rule.pattern.lastIndex = 0
      if (!rule.pattern.test(out)) continue
      rule.pattern.lastIndex = 0
      out = out.replace(rule.pattern, rule.replace)
      hits.add(rule.name)
    }
    return out
  }

  /** Redact a JSON value: strings by pattern, primitives under credential-named keys whole. */
  value(value: unknown, hits: Set<string>, depth = 0): unknown {
    if (typeof value === 'string') return this.text(value, hits)
    if (depth > 32 || value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map((v) => this.value(v, hits, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number') && String(v).length > 0) {
        out[k] = mask('key')
        hits.add('key')
      } else {
        out[k] = this.value(v, hits, depth + 1)
      }
    }
    return out
  }
}

/**
 * Build the redactor from configuration. `mode`: `on` (default) / `off`. `extra`: JSON
 * array of regular expressions (strings), each match replaced by `[REDACTED:custom]`.
 */
export function buildRedactor(mode: string | undefined, extra: string | undefined, warn: (message: string) => void): Redactor | undefined {
  if (mode !== undefined && /^(0|false|no|off|none)$/i.test(mode.trim())) return undefined
  const rules: RedactionRule[] = [...BUILTIN_RULES]
  if (extra) {
    let patterns: unknown
    try { patterns = JSON.parse(extra) } catch { patterns = undefined }
    if (!Array.isArray(patterns)) warn('CLS_AGENTOBS_REDACT_PATTERNS must be a JSON array of regular expressions; ignored')
    else {
      for (const p of patterns) {
        try {
          rules.push({ name: 'custom', pattern: new RegExp(String(p), 'g'), replace: mask('custom') })
        } catch (error) {
          warn(`invalid redaction pattern ${JSON.stringify(p)} ignored: ${String(error)}`)
        }
      }
    }
  }
  return new Redactor(rules)
}
