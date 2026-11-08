/**
 * Keep every span within the CLS per-log size limit (8 MB per stored span).
 *
 * Only captured content can make a span that large (full-content mode, huge tool
 * output or context). When the estimate exceeds the limit, content strings are cut
 * shorter and shorter (type and structure preserved) until the span fits; as a last
 * resort the content attributes are dropped. Ids, timings, usage and status are never
 * touched, so the trace stays complete.
 */
import type { AttrValue, Attributes, SpanRecord } from './otlp/types.ts'

export const CLS_MAX_LOG_BYTES = 8 * 1024 * 1024
/** Room for the fields CLS stores next to the attributes (ids, times, resource, …). */
const MARGIN_BYTES = 256 * 1024

const CONTENT_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
] as const

const MARK = '…[truncated: span size limit]'

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

/** Approximate stored size in bytes (UTF-8 of the JSON CLS keeps). */
export function spanBytes(span: SpanRecord): number {
  return Buffer.byteLength(json({ a: span.attributes, e: span.events, l: span.links, n: span.name, s: span.status }))
}

function longest(value: AttrValue | undefined): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, longest(v)), 0)
  if (value && typeof value === 'object' && !('$double' in value)) return Object.values(value).reduce<number>((m, v) => Math.max(m, longest(v)), 0)
  return 0
}

function cut(value: AttrValue, max: number): AttrValue {
  if (typeof value === 'string') return value.length > max ? value.slice(0, max) + MARK : value
  if (Array.isArray(value)) return value.map((v) => cut(v, max))
  if (value && typeof value === 'object' && !('$double' in value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v, max)]))
  }
  return value
}

/** Shrink content in place until the span fits; returns whether anything was changed. */
export function limitSpanSize(span: SpanRecord, maxBytes = CLS_MAX_LOG_BYTES): boolean {
  const budget = maxBytes - MARGIN_BYTES
  if (spanBytes(span) <= budget) return false
  const attrs: Attributes = span.attributes
  const present = CONTENT_KEYS.filter((k) => attrs[k] !== undefined)
  let max = Math.max(...present.map((k) => longest(attrs[k])), 0)
  while (max > 256 && spanBytes(span) > budget) {
    max = Math.floor(max / 2)
    for (const k of present) attrs[k] = cut(attrs[k]!, max)
  }
  if (spanBytes(span) > budget) for (const k of present) delete attrs[k]
  attrs['agent.custom.span_size_limited'] = true
  attrs['agent.custom.content_truncated'] = true
  return true
}
