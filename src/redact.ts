/**
 * Secret redaction for captured content (messages, tool arguments and results, system
 * instructions). Runs before truncation, so a cut never exposes part of a secret.
 *
 * Four layers, in order:
 *  1. known values: secrets this process actually holds (its own CLS key, credential-named
 *     environment variables such as DEEPSEEK_API_KEY) are masked wherever they appear, in
 *     any wording — the case patterns cannot catch, e.g. a bare cloud SecretKey that is
 *     just 32 random characters;
 *  2. formats with a recognisable shape (vendor prefixes), few false positives;
 *  3. a credential-named key followed by a literal value: `key = v`, `"key": "v"`,
 *     `--secret-key v`, `密码是 v`;
 *  4. values under credential-named keys in structured tool arguments, masked whole.
 * Customers can add patterns. Randomness ("high entropy") is deliberately not used: it
 * would mask commit hashes, checksums and ids, which fill a coding agent's output.
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
/** Chinese wording for a credential. */
const SECRET_KEY_ZH = '(?:访问密钥|密钥|秘钥|私钥|密码|口令|令牌)'

/** End of a value. */
const END = String.raw`(?=[\s"'\`,;}{)\]|<>?]|$)`
/**
 * A literal secret value after a key, not code or a placeholder: not a call
 * (`getToken()`), a property reference (`config.password`), a variable (`$DB_PASS`,
 * `requestToken`, `MCP_TOKEN`), a type (`PtcPermitToken`, `Volatile<string>`, `symbol`),
 * a keyword (`return`), a placeholder (`<token>`), a path or slash command (`/compact`) or a
 * package spec (`workspace:*`, `^1.2`). A single capitalised word (`Buffer`, `Adressen`) is
 * taken for a type or prose.
 * The casing checks are case-sensitive even though the rules are not.
 */
const LITERAL = String.raw`(?!\[REDACTED)(?![$<\`/])`
  + String.raw`(?!(?:undefined|null|true|false|none|nil|empty|required|optional|string|number|boolean|bigint|symbol|unknown|object|any|never|void|return|await|typeof|new|function|async|this)\b)`
  + String.raw`(?![A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+${END})`
  + String.raw`(?!(?-i:(?:[A-Z][a-z]{2,}[0-9]*){2,})${END})`
  // One capitalised word up to 12 letters: a type (`Buffer`) or prose, not a long passphrase.
  + String.raw`(?!(?-i:[A-Z][a-z]{2,11})${END})`
  + String.raw`(?!(?-i:[a-z]{2,}[0-9]*(?:[A-Z][a-z]{2,}[0-9]*)+)${END})`
  + String.raw`(?!(?-i:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)${END})`
  + String.raw`(?!(?-i:[A-Z][A-Za-z0-9]*)<)`
  + String.raw`(?!(?:workspace|npm|file|link|catalog):)(?![~^]?\d+\.\d+)`
/** Where a credential key may start: not inside a word, a package name or a path. */
const KEY_START = String.raw`(?<![/@\w-])`

export const BUILTIN_RULES: readonly RedactionRule[] = [
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replace: mask('private_key'),
  },
  { name: 'tencentcloud_secret_id', pattern: /\bAKID[0-9A-Za-z]{13,40}\b/g, replace: mask('tencentcloud_secret_id') },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: mask('aws_access_key') },
  { name: 'alibaba_access_key', pattern: /\bLTAI[0-9A-Za-z]{12,30}\b/g, replace: mask('alibaba_access_key') },
  { name: 'volcengine_access_key', pattern: /\bAK(?:LT|TP)[0-9A-Za-z_-]{20,100}\b/g, replace: mask('volcengine_access_key') },
  {
    name: 'azure_key',
    pattern: /(?<keep>\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)=)[A-Za-z0-9+/%=&:.-]{20,}/g,
    replace: `$<keep>${mask('azure_key')}`,
  },
  { name: 'huggingface_token', pattern: /\bhf_[A-Za-z0-9]{30,}\b/g, replace: mask('huggingface_token') },
  { name: 'github_token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, replace: mask('github_token') },
  { name: 'gitlab_token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: mask('gitlab_token') },
  { name: 'slack_token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, replace: mask('slack_token') },
  { name: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: mask('google_api_key') },
  { name: 'api_key', pattern: /\bsk-(?:ant-|proj-|live-|test-|or-v1-)?[A-Za-z0-9_-]{20,}\b/g, replace: mask('api_key') },
  { name: 'api_key', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g, replace: mask('api_key') },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: mask('jwt') },
  {
    name: 'authorization',
    pattern: /\b(?<keep>(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{16,}/g,
    replace: `$<keep>${mask('authorization')}`,
  },
  {
    name: 'url_credentials',
    // Bounded scheme / user parts: unbounded ones backtrack quadratically on `a.a.a…`.
    pattern: /\b(?<keep>[a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{1,256}:)[^\s@/]{1,512}(?=@)/gi,
    replace: `$<keep>${mask('url_credentials')}`,
  },
  {
    // KEY=value, "key": "value", key: value — keep the key, mask the literal value.
    name: 'assignment',
    pattern: new RegExp(
      String.raw`(?<keep>${KEY_START}["']?\b${SECRET_KEY}\b["']?\s*[:=]\s*["']?)` + LITERAL
        + String.raw`[^\s"'\`,;}{)(\[\]]{6,}(?=[\s"'\`,;}{)\]]|$)`,
      'gi',
    ),
    replace: `$<keep>${mask('assignment')}`,
  },
  {
    // Command-line flag followed by its value: `--secret-key v`, `--password v`, `-SecretKey v`.
    name: 'cli_flag',
    pattern: new RegExp(
      // Only as a separate word: `${x}-token context` in a template string is not a flag.
      String.raw`(?<keep>(?<=^|[\s"'(=])--?${SECRET_KEY}\s+["']?)(?!-)` + LITERAL
        + String.raw`[^\s"'\`,;}{)(\[\]]{6,}(?=[\s"'\`,;}{)\]]|$)`,
      'gi',
    ),
    replace: `$<keep>${mask('cli_flag')}`,
  },
  {
    // Chinese wording, or an English key with a full-width colon or 是 / 为:
    // `密码是 v`, `SecretKey：v`, `API 密钥为 v`. The value is ASCII, so it ends at Chinese text.
    name: 'assignment',
    pattern: new RegExp(
      // ASCII `:` / `=` after an English key is the rule above (with its code-aware checks).
      String.raw`(?<keep>(?:${SECRET_KEY_ZH}\s*(?:[:：=]|是|为)|${KEY_START}\b${SECRET_KEY}\b\s*(?:：|是|为))\s*["'“]?)` + LITERAL
        // Not followed by a call or index: `密码 = getPassword()` is code.
        + String.raw`[A-Za-z0-9+/=_.~!@#%^&*-]{6,}(?![A-Za-z0-9+/=_.~!@#%^&*(\[-])`,
      'gi',
    ),
    replace: `$<keep>${mask('assignment')}`,
  },
]

/** Environment variable names that hold a credential (not a path or a setting about one). */
const SECRET_ENV_NAME = /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)/i
const NOT_A_VALUE_NAME = /_(?:FILE|PATH|DIR|URL|URI|ENDPOINT|HOST|REGION|MODE|TTL|EXPIRY|EXPIRES|LIMIT|COUNT|SIZE)$/i

/**
 * A value worth masking exactly: long enough and not a plain word, number, path or URL,
 * so masking it never hides ordinary text. At least 8 characters from two character
 * classes, or 20 characters that are not all digits.
 */
export function isMaskableSecret(value: string): boolean {
  const v = value.trim()
  if (v.length < 8 || v.length > 4096 || /\s/.test(v)) return false
  if (/^(?:[/~.]|[A-Za-z]:\\)/.test(v) || /^[a-z][a-z0-9+.-]*:\/\/[^@]*$/i.test(v)) return false
  if (/^[0-9]+$/.test(v)) return false
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length
  return v.length >= 20 || classes >= 2
}

/** Credential values held in an environment (names like `*_SECRET_KEY`, `*_TOKEN`, `*_API_KEY`). */
export function secretsFromEnv(env: NodeJS.ProcessEnv): string[] {
  const out = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_NAME.test(name) || NOT_A_VALUE_NAME.test(name)) continue
    if (isMaskableSecret(value)) out.add(value.trim())
  }
  return [...out]
}

export class Redactor {
  private readonly rules: readonly RedactionRule[]
  private readonly known: () => readonly string[]
  private knownSorted: readonly string[] = []
  private knownSource: readonly string[] | undefined

  /**
   * @param known - exact secret values to mask wherever they appear; read on every call
   *   so rotated credentials are covered.
   */
  constructor(rules: readonly RedactionRule[], known: () => readonly string[] = () => []) {
    this.rules = rules
    this.known = known
  }

  /** Redact one string; records the rule names that matched into `hits`. */
  text(value: string, hits: Set<string>): string {
    let out = value
    const known = this.known()
    if (known !== this.knownSource) {
      // Longest first, so a secret containing another is masked whole.
      this.knownSorted = [...known].filter(isMaskableSecret).sort((a, b) => b.length - a.length)
      this.knownSource = known
    }
    for (const secret of this.knownSorted) {
      if (!out.includes(secret)) continue
      out = out.split(secret).join(mask('known_secret'))
      hits.add('known_secret')
    }
    for (const rule of this.rules) {
      rule.pattern.lastIndex = 0
      const next = out.replace(rule.pattern, rule.replace)
      if (next !== out) hits.add(rule.name)
      out = next
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
export function buildRedactor(
  mode: string | undefined,
  extra: string | undefined,
  warn: (message: string) => void,
  known: () => readonly string[] = () => [],
): Redactor | undefined {
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
  return new Redactor(rules, known)
}
