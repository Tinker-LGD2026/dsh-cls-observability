import { describe, expect, it } from 'vitest'
import { encodeExportRequest } from '../src/otlp/encode.ts'
import { double, SpanKind, StatusCode } from '../src/otlp/types.ts'
import { decode, kvToObject } from './otlp-schema.ts'

const traceId = '0123456789abcdef0123456789abcdef'
const spanId = 'fedcba9876543210'

describe('encodeExportRequest', () => {
  it('round-trips through the official OTLP schema', () => {
    const bytes = encodeExportRequest({
      resource: { 'service.name': 'deepseek-harness', 'process.pid': 42 },
      scope: { name: 'agentobs-dsh', version: '0.1.0' },
      spans: [{
        traceId,
        spanId,
        parentSpanId: '1111111111111111',
        name: 'chat deepseek-v4',
        kind: SpanKind.Client,
        startNs: 1_787_150_761_999_000_000n,
        endNs: 1_787_150_802_462_000_000n,
        attributes: {
          'gen_ai.span.kind': 'chat',
          'gen_ai.usage.input_tokens': 1000,
          'gen_ai.usage.output_tokens': 0,
          'gen_ai.request.temperature': double(1),
          'gen_ai.response.finish_reasons': ['stop'],
          'flag': false,
          'nested': { a: 1, b: ['x'] },
          'skipped': undefined,
        },
        status: { code: StatusCode.Error, message: 'boom' },
        events: [{ timeNs: 1_787_150_770_000_000_000n, name: 'retry', attributes: { delayMs: 500 } }],
        links: [{ traceId, spanId: '2222222222222222' }],
      }],
    })

    const decoded = decode(bytes)
    const rs = decoded.resource_spans[0]
    expect(kvToObject(rs.resource.attributes)).toEqual({ 'service.name': 'deepseek-harness', 'process.pid': 42 })
    const ss = rs.scope_spans[0]
    expect(ss.scope).toEqual({ name: 'agentobs-dsh', version: '0.1.0' })
    const span = ss.spans[0]
    expect(Buffer.from(span.trace_id, 'base64').toString('hex')).toBe(traceId)
    expect(Buffer.from(span.span_id, 'base64').toString('hex')).toBe(spanId)
    expect(Buffer.from(span.parent_span_id, 'base64').toString('hex')).toBe('1111111111111111')
    expect(span.name).toBe('chat deepseek-v4')
    expect(span.kind).toBe(3)
    expect(span.start_time_unix_nano).toBe('1787150761999000000')
    expect(span.end_time_unix_nano).toBe('1787150802462000000')
    expect(kvToObject(span.attributes)).toEqual({
      'gen_ai.span.kind': 'chat',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.request.temperature': { double: 1 },
      'gen_ai.response.finish_reasons': ['stop'],
      'flag': false,
      'nested': { a: 1, b: ['x'] },
    })
    expect(span.status).toEqual({ message: 'boom', code: 2 })
    expect(span.events[0].name).toBe('retry')
    expect(kvToObject(span.events[0].attributes)).toEqual({ delayMs: 500 })
    expect(Buffer.from(span.links[0].span_id, 'base64').toString('hex')).toBe('2222222222222222')
  })

  it('encodes negative int64 and non-integer numbers as double', () => {
    const decoded = decode(encodeExportRequest({
      resource: {},
      scope: { name: 's', version: '1' },
      spans: [{ traceId, spanId, name: 'n', kind: SpanKind.Internal, startNs: 1n, endNs: 2n, attributes: { neg: -5, frac: 0.5 } }],
    }))
    expect(kvToObject(decoded.resource_spans[0].scope_spans[0].spans[0].attributes)).toEqual({ neg: -5, frac: { double: 0.5 } })
  })

  it('rejects malformed ids', () => {
    expect(() => encodeExportRequest({
      resource: {}, scope: { name: 's', version: '1' },
      spans: [{ traceId: 'zz', spanId, name: 'n', kind: 1, startNs: 1n, endNs: 2n, attributes: {} }],
    })).toThrow(/invalid hex/)
  })
})
