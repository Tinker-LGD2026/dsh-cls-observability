/**
 * Outbox delivery outside the host process.
 *
 * When a short-lived DSH run exits before its last spans are sent, the plugin
 * spills them and starts this deliverer as a detached child process
 * (`node dsh-cls-observability.mjs --agentobs-deliver <dir>`), so delivery no longer
 * depends on the host's shutdown budget. Anything still undelivered stays in
 * the outbox for the next plugin start or a relay.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { exportGzipBody, type Credentials, type ExporterConfig } from './exporter.ts'
import { Outbox } from './outbox.ts'

export const DELIVER_FLAG = '--agentobs-deliver'

export interface DeliverOptions {
  attempts?: number
  fetchImpl?: typeof fetch
  /**
   * How long to wait for files other live processes still hold. The host claims the
   * batch that is in flight at shutdown and may stay blocked for tens of seconds in its
   * own teardown; once it exits, that file is ours to send. Bounded so the deliverer
   * always ends; anything left is resent on the next plugin start.
   */
  claimWaitMs?: number
  pollMs?: number
}

export async function deliverOutbox(
  dir: string,
  exporter: ExporterConfig,
  log: (message: string) => void = () => {},
  options: DeliverOptions = {},
): Promise<{ delivered: number; remaining: number }> {
  const { attempts = 4, fetchImpl = fetch, claimWaitMs = 120_000, pollMs = 500 } = options
  const outbox = new Outbox(dir)
  const waitUntil = Date.now() + claimWaitMs
  let delivered = 0
  for (;;) {
    outbox.recoverStaleClaims()
    const round = await deliverPending(outbox, exporter, log, attempts, fetchImpl)
    delivered += round.delivered
    if (round.stop || outbox.foreignClaims() === 0 || Date.now() >= waitUntil) break
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return { delivered, remaining: outbox.pending().length }
}

async function deliverPending(
  outbox: Outbox,
  exporter: ExporterConfig,
  log: (message: string) => void,
  attempts: number,
  fetchImpl: typeof fetch,
): Promise<{ delivered: number; stop: boolean }> {
  let delivered = 0
  for (let attempt = 0; attempt < attempts; attempt++) {
    let failed = false
    for (const file of outbox.pending()) {
      const claimed = outbox.claim(file)
      if (!claimed) continue
      const body = outbox.read(claimed)
      if (!body) { outbox.release(claimed); continue }
      const result = await exportGzipBody(exporter, body, fetchImpl)
      if (result.kind === 'ok' || result.kind === 'rejected') {
        outbox.remove(claimed)
        if (result.kind === 'ok') delivered++
        else log(`dropped rejected file: ${result.error}`)
      } else {
        outbox.release(claimed)
        log(`delivery failed (${result.kind}): ${result.error}`)
        failed = true
        if (result.kind === 'auth') return { delivered, stop: true }
        break
      }
    }
    if (!failed) return { delivered, stop: false }
    await new Promise((r) => setTimeout(r, 2_000 * 2 ** attempt))
  }
  // Retries exhausted: the destination is down, leave the files for the next start.
  return { delivered, stop: true }
}

export interface DelivererSpawn {
  dir: string
  endpoint: string
  topicId?: string
  credentials?: Credentials
  credentialsFile?: string
  /** Proxy variables resolved from trusted environment layers. */
  proxy: Record<string, string>
}

/** Start a detached deliverer process; returns false when spawning is not possible. */
export function spawnDeliverer(input: DelivererSpawn, moduleUrl: string): boolean {
  try {
    const env: Record<string, string> = {
      AGENTOBS_DELIVER_ENDPOINT: input.endpoint,
      ...(input.topicId ? { AGENTOBS_DELIVER_TOPIC_ID: input.topicId } : {}),
      ...(input.credentialsFile ? { AGENTOBS_DELIVER_CREDENTIALS_FILE: input.credentialsFile } : {}),
      ...(!input.credentialsFile && input.credentials
        ? { TENCENTCLOUD_SECRET_ID: input.credentials.secretId, TENCENTCLOUD_SECRET_KEY: input.credentials.secretKey }
        : {}),
      ...input.proxy,
      ...(Object.keys(input.proxy).length > 0 ? { NODE_USE_ENV_PROXY: '1' } : {}),
    }
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'USERPROFILE']) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    const child = spawn(process.execPath, [fileURLToPath(moduleUrl), DELIVER_FLAG, input.dir], {
      detached: true,
      stdio: 'ignore',
      env,
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
