/**
 * DEV ONLY. Credentials for the e2e / spike scripts. Never print the returned values.
 *
 * Read from the environment:
 *   CLS_AGENTOBS_REGION (default ap-shanghai), CLS_AGENTOBS_TOPIC_ID,
 *   TENCENTCLOUD_SECRET_ID, TENCENTCLOUD_SECRET_KEY, DEEPSEEK_API_KEY (optional)
 * or, when AGENTOBS_DEV_SECRETS_FILE is set, from that file: `key: value` / `key=value`
 * lines using the lowercase names region, topic_id, tencentcloud_secret_id,
 * tencentcloud_secret_key, deepseek_api_key. Keep that file outside the repository.
 *
 * The shipped plugin never reads this; it only trusts the real process environment.
 */
import { readFileSync } from 'node:fs'

export interface DevSecrets {
  region: string
  topicId: string
  secretId: string
  secretKey: string
  deepseekApiKey?: string
}

function fromFile(file: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*[-*]?\s*`?([A-Za-z_][A-Za-z0-9_]*)`?\s*[:=：]\s*`?([^`\s]+)`?/.exec(line)
    if (m) map.set(m[1]!.toLowerCase(), m[2]!)
  }
  return map
}

function fromEnv(): Map<string, string> {
  const pairs: [string, string | undefined][] = [
    ['region', process.env.CLS_AGENTOBS_REGION],
    ['topic_id', process.env.CLS_AGENTOBS_TOPIC_ID],
    ['tencentcloud_secret_id', process.env.TENCENTCLOUD_SECRET_ID],
    ['tencentcloud_secret_key', process.env.TENCENTCLOUD_SECRET_KEY],
    ['deepseek_api_key', process.env.DEEPSEEK_API_KEY],
  ]
  return new Map(pairs.filter((p): p is [string, string] => typeof p[1] === 'string' && p[1] !== ''))
}

export function loadDevSecrets(file = process.env.AGENTOBS_DEV_SECRETS_FILE): DevSecrets {
  const map = file ? fromFile(file) : fromEnv()
  const need = (key: string): string => {
    const value = map.get(key)
    if (!value) throw new Error(`dev secrets: missing "${key}" (set the environment variables or AGENTOBS_DEV_SECRETS_FILE)`)
    return value
  }
  return {
    region: map.get('region') ?? 'ap-shanghai',
    topicId: need('topic_id'),
    secretId: need('tencentcloud_secret_id'),
    secretKey: need('tencentcloud_secret_key'),
    ...(map.get('deepseek_api_key') ? { deepseekApiKey: map.get('deepseek_api_key')! } : {}),
  }
}

/** Environment for child processes in dev runs (real process env, as the plugin requires). */
export function devEnv(secrets: DevSecrets): Record<string, string> {
  return {
    CLS_AGENTOBS_ENABLED: 'true',
    CLS_AGENTOBS_REGION: secrets.region,
    CLS_AGENTOBS_TOPIC_ID: secrets.topicId,
    TENCENTCLOUD_SECRET_ID: secrets.secretId,
    TENCENTCLOUD_SECRET_KEY: secrets.secretKey,
    ...(secrets.deepseekApiKey ? { DEEPSEEK_API_KEY: secrets.deepseekApiKey } : {}),
  }
}
