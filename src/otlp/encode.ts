/**
 * Encode an ExportBatch as an OTLP `ExportTraceServiceRequest` (protobuf).
 * Field numbers follow opentelemetry-proto v1 (trace.proto / common.proto / resource.proto).
 */

import { ProtoWriter } from './proto.ts'
import type { AttrValue, Attributes, ExportBatch, SpanRecord } from './types.ts'

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error(`invalid hex id: ${hex}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function isDouble(value: unknown): value is { $double: number } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { $double?: unknown }).$double === 'number'
}

/** AnyValue: string=1 bool=2 int=3 double=4 array=5 kvlist=6 bytes=7 */
function writeAnyValue(w: ProtoWriter, value: AttrValue): void {
  if (typeof value === 'string') w.string(1, value, true)
  else if (typeof value === 'boolean') w.varintAlways(2, value)
  else if (typeof value === 'bigint') w.varintAlways(3, value)
  else if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) w.varintAlways(3, value)
    else w.doubleAlways(4, value)
  } else if (isDouble(value)) w.doubleAlways(4, value.$double)
  else if (Array.isArray(value)) {
    w.message(5, (arr) => {
      for (const item of value as readonly AttrValue[]) arr.message(1, (av) => writeAnyValue(av, item), true)
    }, true)
  } else {
    w.message(6, (kvl) => writeKeyValues(kvl, 1, value as Attributes), true)
  }
}

/** KeyValue: key=1 value=2 */
function writeKeyValues(w: ProtoWriter, field: number, attrs: Attributes | undefined): void {
  if (!attrs) return
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    w.message(field, (kv) => {
      kv.string(1, key, true)
      kv.message(2, (av) => writeAnyValue(av, value), true)
    }, true)
  }
}

/** Span field numbers per trace.proto. */
function writeSpan(w: ProtoWriter, span: SpanRecord): void {
  w.bytes(1, hexToBytes(span.traceId))
  w.bytes(2, hexToBytes(span.spanId))
  if (span.parentSpanId) w.bytes(4, hexToBytes(span.parentSpanId))
  w.string(5, span.name, true)
  w.varint(6, span.kind)
  w.fixed64(7, span.startNs)
  w.fixed64(8, span.endNs)
  writeKeyValues(w, 9, span.attributes)
  for (const event of span.events ?? []) {
    w.message(11, (e) => {
      e.fixed64(1, event.timeNs)
      e.string(2, event.name, true)
      writeKeyValues(e, 3, event.attributes)
    }, true)
  }
  for (const link of span.links ?? []) {
    w.message(13, (l) => {
      l.bytes(1, hexToBytes(link.traceId))
      l.bytes(2, hexToBytes(link.spanId))
      writeKeyValues(l, 4, link.attributes)
    }, true)
  }
  if (span.status && (span.status.code !== 0 || span.status.message)) {
    const status = span.status
    w.message(15, (s) => {
      s.string(2, status.message)
      s.varint(3, status.code)
    }, true)
  }
}

export function encodeExportRequest(batch: ExportBatch): Uint8Array {
  const w = new ProtoWriter()
  w.message(1, (rs) => {
    rs.message(1, (res) => writeKeyValues(res, 1, batch.resource), true)
    rs.message(2, (ss) => {
      ss.message(1, (scope) => {
        scope.string(1, batch.scope.name)
        scope.string(2, batch.scope.version)
      }, true)
      for (const span of batch.spans) ss.message(2, (s) => writeSpan(s, span), true)
    }, true)
  }, true)
  return w.finish()
}
