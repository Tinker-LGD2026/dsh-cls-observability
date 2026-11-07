/** DEV ONLY. Minimal Tencent Cloud API v3 (TC3-HMAC-SHA256) client for CLS, used to verify stored spans. */
import { createHash, createHmac } from 'node:crypto'
import type { DevSecrets } from './dev-secrets.ts'

const HOST = 'cls.tencentcloudapi.com'
const SERVICE = 'cls'
const VERSION = '2020-10-16'

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

export async function clsApi<T = any>(secrets: DevSecrets, action: string, payload: unknown): Promise<T> {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const body = JSON.stringify(payload)
  const contentType = 'application/json; charset=utf-8'
  const canonicalHeaders = `content-type:${contentType}\nhost:${HOST}\nx-tc-action:${action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256(body)}`
  const scope = `${date}/${SERVICE}/tc3_request`
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`
  const signing = hmac(hmac(hmac(`TC3${secrets.secretKey}`, date), SERVICE), 'tc3_request')
  const signature = createHmac('sha256', signing).update(stringToSign).digest('hex')
  const response = await fetch(`https://${HOST}`, {
    method: 'POST',
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${secrets.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'Content-Type': contentType,
      Host: HOST,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': VERSION,
      'X-TC-Region': secrets.region,
    },
    body,
  })
  const json = await response.json() as { Response: T & { Error?: { Code: string; Message: string } } }
  if (json.Response.Error) throw new Error(`${action}: ${json.Response.Error.Code} ${json.Response.Error.Message}`)
  return json.Response
}

export interface StoredSpan {
  traceID: string
  spanID: string
  parentSpanID?: string
  name: string
  kind: string
  statusCode?: string
  attribute: Record<string, unknown>
  resource: Record<string, unknown>
  raw: Record<string, unknown>
}

/** Search spans in a time window, filtered client-side by predicate. */
export async function searchSpans(secrets: DevSecrets, fromMs: number, toMs: number, query = '*', limit = 1000): Promise<StoredSpan[]> {
  const result = await clsApi<{ Results?: { LogJson?: string }[] }>(secrets, 'SearchLog', {
    TopicId: secrets.topicId,
    From: fromMs,
    To: toMs,
    Query: query,
    Limit: limit,
    Sort: 'asc',
    SyntaxRule: 1,
  })
  const parse = (v: unknown): Record<string, unknown> => {
    if (typeof v === 'string') { try { return JSON.parse(v) } catch { return { $raw: v } } }
    return (v as Record<string, unknown>) ?? {}
  }
  return (result.Results ?? []).map((r) => {
    const raw = JSON.parse(r.LogJson ?? '{}') as Record<string, unknown>
    return {
      traceID: String(raw.traceID ?? ''),
      spanID: String(raw.spanID ?? ''),
      parentSpanID: raw.parentSpanID ? String(raw.parentSpanID) : undefined,
      name: String(raw.name ?? ''),
      kind: String(raw.kind ?? ''),
      statusCode: raw.statusCode ? String(raw.statusCode) : undefined,
      attribute: parse(raw.attribute),
      resource: parse(raw.resource),
      raw,
    }
  })
}
