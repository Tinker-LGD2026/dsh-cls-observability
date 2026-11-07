/**
 * Configuration from the launch environment.
 * Security rule: every value is read only from the real process environment
 * (optionally also `$DSH_HOME/.env`), never from a project `.env`, which a
 * cloned repository controls.
 */
import { buildRedactor, type Redactor } from './redact.ts'
import { readFileSync, statSync } from 'node:fs'
import type { Credentials } from './exporter.ts'

export type EnvSource = 'process' | 'project-env' | 'user-env'
export interface EnvEntry { value: string; source: EnvSource }
export interface EnvReader {
  getFrom(name: string, sources: readonly EnvSource[]): EnvEntry | undefined
}

export interface AgentObsConfig {
  endpoint: string
  topicId?: string
  credentials?: () => Credentials | undefined
  credentialsFile?: string
  /** Explicit outbox directory; default `$DSH_HOME/agentobs/outbox`. */
  dataDir?: string
  /** Spawn a detached process to deliver spans spilled at exit. */
  detachedDelivery: boolean
  /** Write-ahead journal: spans are on disk before they are sent (survives a crash). */
  journal: boolean
  /** Proxy variables from trusted layers, forwarded to the detached deliverer. */
  proxy: Record<string, string>
  region?: string
  captureContent: boolean
  maxContentChars: number
  /** Secret redaction of captured content; undefined when switched off. */
  redactor?: Redactor
  includeAuxiliary: boolean
  serviceName: string
  deploymentEnvironment?: string
  entryType?: string
  entryPlatform?: string
  /** Name of the DSH profile running this process, when launched by dsh. */
  profile?: string
  userId?: string
  userName?: string
  custom: Record<string, string>
  sampleRatio: number
  timeoutMs: number
  shutdownTimeoutMs: number
  maxQueueSpans: number
  debug: boolean
}

export type ConfigResult =
  | { enabled: true; config: AgentObsConfig; warnings: string[] }
  | { enabled: false; reason: string; warnings: string[] }

const WATCHED = [
  'CLS_AGENTOBS_ENABLED', 'CLS_AGENTOBS_ENDPOINT', 'CLS_AGENTOBS_TOPIC_ID', 'CLS_AGENTOBS_REGION', 'CLS_AGENTOBS_NETWORK',
  'CLS_AGENTOBS_CAPTURE_CONTENT', 'CLS_AGENTOBS_REDACT', 'CLS_AGENTOBS_REDACT_PATTERNS', 'CLS_AGENTOBS_CREDENTIALS_FILE',
  'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY',
]

/** Environment reader over plain `process.env` (no layer information: everything counts as `process`). */
export function processEnvReader(env: NodeJS.ProcessEnv = process.env): EnvReader {
  return {
    getFrom(name, sources) {
      const value = env[name]
      return value !== undefined && sources.includes('process') ? { value, source: 'process' } : undefined
    },
  }
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname)
}

function parseCustom(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const key = pair.slice(0, i).trim().replace(/^agent\.custom\./, '')
    const value = pair.slice(i + 1).trim()
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(key) && !/secret|password|token|key/i.test(key)) out[key] = value.slice(0, 256)
  }
  return out
}

/** Credentials file: JSON `{secretId, secretKey}` or `KEY=value` lines; re-read when it changes. */
function fileCredentials(file: string): () => Credentials | undefined {
  let cachedMtime = -1
  let cached: Credentials | undefined
  return () => {
    try {
      const mtime = statSync(file).mtimeMs
      if (mtime === cachedMtime) return cached
      const text = readFileSync(file, 'utf8')
      let id: string | undefined
      let key: string | undefined
      try {
        const json = JSON.parse(text) as Record<string, unknown>
        id = String(json.secretId ?? json.SecretId ?? json.TENCENTCLOUD_SECRET_ID ?? '')
        key = String(json.secretKey ?? json.SecretKey ?? json.TENCENTCLOUD_SECRET_KEY ?? '')
      } catch {
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*([A-Za-z_]+)\s*[=:]\s*(\S+)/.exec(line)
          if (m?.[1] === 'TENCENTCLOUD_SECRET_ID') id = m[2]
          if (m?.[1] === 'TENCENTCLOUD_SECRET_KEY') key = m[2]
        }
      }
      cachedMtime = mtime
      cached = id && key ? { secretId: id, secretKey: key } : undefined
      return cached
    } catch {
      return cached
    }
  }
}

export type ContentMode = 'off' | 'truncate' | 'full'

/**
 * Content capture mode. Default `truncate`: the CLS AgentObs spec marks chat input/output
 * and tool arguments/result as required fields. `true` = truncate, `false` = off.
 */
export function parseContentMode(raw: string | undefined): ContentMode | undefined {
  if (raw === undefined) return 'truncate'
  const v = raw.trim().toLowerCase()
  if (/^(0|false|no|off|none)$/.test(v)) return 'off'
  if (/^(1|true|yes|on|truncate)$/.test(v)) return 'truncate'
  if (v === 'full') return 'full'
  return undefined
}

/**
 * Entry type/platform from the DSH profile actually running this process (lowercase, as
 * in the CLS spec's `cli / ide / gateway / api` examples). Shipped profiles map to their
 * surface; a custom profile reports its own name; with no profile (not launched by dsh)
 * nothing is reported rather than guessed. `CLS_AGENTOBS_ENTRY_TYPE/PLATFORM` override.
 */
export function entryForProfile(profile: string | undefined): { type?: string; platform?: string } {
  if (!profile) return {}
  switch (profile.toLowerCase()) {
    case 'headless': return { type: 'cli', platform: 'terminal' }
    case 'web': return { type: 'web', platform: 'browser' }
    case 'desktop': return { type: 'desktop', platform: 'desktop' }
    case 'sdk':
    case 'sdk-minimal': return { type: 'sdk', platform: 'sdk' }
    case 'acp': return { type: 'acp', platform: 'acp' }
    default: return { type: profile, platform: profile }
  }
}

export function resolveConfig(env: EnvReader, profileName?: string): ConfigResult {
  const warnings: string[] = []
  const trustUserEnv = truthy(env.getFrom('CLS_AGENTOBS_TRUST_USER_ENV', ['process'])?.value)
  const trusted: EnvSource[] = trustUserEnv ? ['process', 'user-env'] : ['process']
  const get = (name: string): string | undefined => {
    const v = env.getFrom(name, trusted)?.value
    return v === undefined || v.trim() === '' ? undefined : v.trim()
  }
  for (const name of WATCHED) {
    if (env.getFrom(name, ['project-env']) && !env.getFrom(name, trusted)) {
      warnings.push(`${name} from a project .env is ignored; set it in the process environment`)
    }
  }

  if (!truthy(get('CLS_AGENTOBS_ENABLED'))) return { enabled: false, reason: 'CLS_AGENTOBS_ENABLED is not true in the process environment', warnings }

  const region = get('CLS_AGENTOBS_REGION')
  const network = get('CLS_AGENTOBS_NETWORK') === 'internal' ? 'tencentyun' : 'tencentcs'
  const custom = get('CLS_AGENTOBS_ENDPOINT')
  let endpoint: string
  if (custom) {
    let url: URL
    try { url = new URL(custom) } catch { return { enabled: false, reason: `invalid CLS_AGENTOBS_ENDPOINT`, warnings } }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLoopback(url.hostname) || truthy(get('CLS_AGENTOBS_ALLOW_HTTP'))))) {
      return { enabled: false, reason: 'CLS_AGENTOBS_ENDPOINT must use https (http only for loopback or with CLS_AGENTOBS_ALLOW_HTTP=true)', warnings }
    }
    endpoint = url.toString()
  } else {
    if (!region || !/^[a-z]{2,}-[a-z]+(-[a-z0-9]+)*$/.test(region)) return { enabled: false, reason: 'CLS_AGENTOBS_REGION is required (e.g. ap-shanghai)', warnings }
    endpoint = `https://${region}.cls.${network}.com/v1/traces`
  }

  const topicId = get('CLS_AGENTOBS_TOPIC_ID')
  const credentialsFile = get('CLS_AGENTOBS_CREDENTIALS_FILE')
  let credentials: (() => Credentials | undefined) | undefined
  if (credentialsFile) credentials = fileCredentials(credentialsFile)
  else {
    const secretId = get('TENCENTCLOUD_SECRET_ID')
    const secretKey = get('TENCENTCLOUD_SECRET_KEY')
    if (secretId && secretKey) {
      const fixed = { secretId, secretKey }
      credentials = () => fixed
    }
    if (get('TENCENTCLOUD_SESSION_TOKEN') || get('TENCENTCLOUD_TOKEN')) {
      warnings.push('temporary STS credentials are not supported yet; use long-term keys or a relay')
    }
  }
  if (!custom && !topicId) return { enabled: false, reason: 'CLS_AGENTOBS_TOPIC_ID is required', warnings }
  if (!custom && !credentials) return { enabled: false, reason: 'TENCENTCLOUD_SECRET_ID/TENCENTCLOUD_SECRET_KEY or CLS_AGENTOBS_CREDENTIALS_FILE is required', warnings }

  const num = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name)
    const n = raw === undefined ? fallback : Number(raw)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  const entry = entryForProfile(profileName)
  const entryType = get('CLS_AGENTOBS_ENTRY_TYPE') ?? entry.type
  const entryPlatform = get('CLS_AGENTOBS_ENTRY_PLATFORM') ?? entry.platform
  const rawMode = get('CLS_AGENTOBS_CAPTURE_CONTENT') ?? get('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT')
  const contentMode = parseContentMode(rawMode)
  const redactor = buildRedactor(get('CLS_AGENTOBS_REDACT'), get('CLS_AGENTOBS_REDACT_PATTERNS'), (m) => warnings.push(m))
  if (rawMode !== undefined && contentMode === undefined) warnings.push(`unknown content capture mode "${rawMode}"; using truncate`)
  const dataDir = get('CLS_AGENTOBS_DATA_DIR')
  const proxy: Record<string, string> = {}
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    const value = get(name)
    if (value) proxy[name] = value
  }
  const userId = get('CLS_AGENTOBS_USER_ID')
  const userName = get('CLS_AGENTOBS_USER_NAME')
  const deploymentEnvironment = get('CLS_AGENTOBS_ENVIRONMENT')
  return {
    enabled: true,
    warnings,
    config: {
      endpoint,
      ...(topicId ? { topicId } : {}),
      ...(credentials ? { credentials } : {}),
      ...(credentialsFile ? { credentialsFile } : {}),
      ...(dataDir ? { dataDir } : {}),
      detachedDelivery: get('CLS_AGENTOBS_DETACHED_DELIVERY') === undefined ? true : truthy(get('CLS_AGENTOBS_DETACHED_DELIVERY')),
      journal: get('CLS_AGENTOBS_JOURNAL') === undefined ? true : truthy(get('CLS_AGENTOBS_JOURNAL')),
      proxy,
      ...(region ? { region } : {}),
      captureContent: (contentMode ?? 'truncate') !== 'off',
      maxContentChars: contentMode === 'full' ? 1_000_000 : num('CLS_AGENTOBS_CONTENT_MAX_CHARS', 32_000, 256, 1_000_000),
      ...(redactor ? { redactor } : {}),
      includeAuxiliary: get('CLS_AGENTOBS_INCLUDE_AUXILIARY') === undefined ? true : truthy(get('CLS_AGENTOBS_INCLUDE_AUXILIARY')),
      serviceName: get('CLS_AGENTOBS_SERVICE_NAME') ?? 'deepseek-harness',
      ...(deploymentEnvironment ? { deploymentEnvironment } : {}),
      ...(entryType ? { entryType } : {}),
      ...(entryPlatform ? { entryPlatform } : {}),
      ...(profileName ? { profile: profileName } : {}),
      ...(userId ? { userId } : {}),
      ...(userName ? { userName } : {}),
      custom: parseCustom(get('CLS_AGENTOBS_CUSTOM_ATTRIBUTES')),
      sampleRatio: num('CLS_AGENTOBS_SAMPLE_RATIO', 1, 0, 1),
      timeoutMs: num('CLS_AGENTOBS_EXPORT_TIMEOUT_MS', 15_000, 1_000, 120_000),
      // DSH force-exits 5s after shutdown starts (apps/cli/src/process-shutdown.ts); stay inside it.
      shutdownTimeoutMs: num('CLS_AGENTOBS_SHUTDOWN_TIMEOUT_MS', 3_500, 0, 60_000),
      maxQueueSpans: num('CLS_AGENTOBS_MAX_QUEUE_SPANS', 20_000, 100, 1_000_000),
      debug: truthy(get('CLS_AGENTOBS_DEBUG')),
    },
  }
}
