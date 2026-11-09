/**
 * OTLP/HTTP protobuf exporter for CLS `/v1/traces`.
 * Single attempt per call; retry policy belongs to the queue that drives it.
 */

import { gzipSync } from 'node:zlib'
import { encodeExportRequest } from './otlp/encode.ts'
import type { ExportBatch } from './otlp/types.ts'

export interface Credentials {
  secretId: string
  secretKey: string
}

export interface ExporterConfig {
  endpoint: string
  /** CLS trace topic; sent as the `topic_id` header. Omit when exporting to a relay/collector. */
  topicId?: string
  credentials?: () => Credentials | undefined
  headers?: Record<string, string>
  timeoutMs: number
  gzip: boolean
}

export type ExportResult =
  | { kind: 'ok'; status: number }
  /** Network error, timeout, 408/429/5xx: keep data and retry later. */
  | { kind: 'retryable'; status?: number; retryAfterMs?: number; error: string }
  /** 401/403: credentials problem; keep data, pause, alert. */
  | { kind: 'auth'; status: number; error: string }
  /** 404: wrong topic or endpoint; a configuration problem, never the payload: keep data, pause. */
  | { kind: 'config'; status: number; error: string }
  /** Other 4xx (400, 413, …): the payload itself is rejected; isolate and drop. */
  | { kind: 'rejected'; status: number; error: string }

const MAX_ERROR_BODY = 512
const MAX_RETRY_AFTER_MS = 5 * 60_000

function secureFor(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'https:' || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
  } catch {
    return false
  }
}

export function basicAuth(credentials: Credentials): string {
  return `Basic ${Buffer.from(`${credentials.secretId}:${credentials.secretKey}`).toString('base64')}`
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  // Capped: a huge value would overflow setTimeout, which then fires after 1 ms.
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000))
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()))
}

export function classifyStatus(status: number, body: string, retryAfter: string | null): ExportResult {
  if (status >= 200 && status < 300) return { kind: 'ok', status }
  const error = `HTTP ${status}: ${body.slice(0, MAX_ERROR_BODY)}`
  if (status === 408 || status === 429 || status >= 500) {
    const retryAfterMs = parseRetryAfter(retryAfter)
    return retryAfterMs === undefined ? { kind: 'retryable', status, error } : { kind: 'retryable', status, retryAfterMs, error }
  }
  if (status === 401 || status === 403) return { kind: 'auth', status, error }
  if (status === 404) return { kind: 'config', status, error }
  return { kind: 'rejected', status, error }
}

export function buildRequest(config: ExporterConfig, batch: ExportBatch): { headers: Record<string, string>; body: Uint8Array } {
  const raw = encodeExportRequest(batch)
  const headers: Record<string, string> = { 'Content-Type': 'application/x-protobuf', ...config.headers }
  let body = raw
  if (config.gzip) {
    body = gzipSync(raw)
    headers['Content-Encoding'] = 'gzip'
  }
  if (config.topicId) headers['topic_id'] = config.topicId
  const credentials = config.credentials?.()
  // Basic credentials are base64, i.e. plain text: never over http to another host.
  if (credentials && secureFor(config.endpoint)) headers['Authorization'] = basicAuth(credentials)
  return { headers, body }
}

/** Encode a batch into a gzip-compressed OTLP request body (used for durable spill files). */
export function encodeGzipBody(batch: ExportBatch): Uint8Array {
  return gzipSync(encodeExportRequest(batch))
}

/** POST an already-encoded, gzip-compressed OTLP request body (outbox delivery). */
export function exportGzipBody(config: ExporterConfig, body: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<ExportResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip', ...config.headers }
  if (config.topicId) headers['topic_id'] = config.topicId
  const credentials = config.credentials?.()
  // Basic credentials are base64, i.e. plain text: never over http to another host.
  if (credentials && secureFor(config.endpoint)) headers['Authorization'] = basicAuth(credentials)
  return post(config, { headers, body }, fetchImpl)
}

export async function exportBatch(config: ExporterConfig, batch: ExportBatch, fetchImpl: typeof fetch = fetch): Promise<ExportResult> {
  let request: { headers: Record<string, string>; body: Uint8Array }
  try {
    request = buildRequest(config, batch)
  } catch (error) {
    // Encoding failures are payload problems, never transient.
    return { kind: 'rejected', status: 0, error: `encode failed: ${String(error)}` }
  }
  return post(config, request, fetchImpl)
}

/** At most `limit` bytes of a response body (only error messages are read). */
async function readBounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < limit) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
    }
  } catch { /* partial body is enough */ } finally {
    reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8')
}

async function post(config: ExporterConfig, request: { headers: Record<string, string>; body: Uint8Array }, fetchImpl: typeof fetch): Promise<ExportResult> {
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body as unknown as BodyInit,
      signal: AbortSignal.timeout(config.timeoutMs),
      // A redirect would resend the spans (and, same-origin, the credentials) elsewhere.
      redirect: 'error',
    })
    const text = await readBounded(response, MAX_ERROR_BODY * 4)
    return classifyStatus(response.status, text, response.headers.get('retry-after'))
  } catch (error) {
    return { kind: 'retryable', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}
