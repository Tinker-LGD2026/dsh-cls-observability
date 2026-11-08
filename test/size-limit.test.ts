import { describe, expect, it } from 'vitest'
import { SpanKind, type SpanRecord } from '../src/otlp/types.ts'
import { CLS_MAX_LOG_BYTES, limitSpanSize, spanBytes } from '../src/size-limit.ts'

const span = (attributes: SpanRecord['attributes']): SpanRecord => ({
  traceId: '0'.repeat(32), spanId: '1'.repeat(16), name: 'chat m', kind: SpanKind.Client, startNs: 1n, endNs: 2n, attributes,
})

describe('per-log size limit', () => {
  it('leaves normal spans untouched', () => {
    const s = span({ 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hi' }] }], 'gen_ai.usage.input_tokens': 10 })
    const before = structuredClone(s)
    expect(limitSpanSize(s)).toBe(false)
    expect(s).toEqual(before)
  })

  it('shortens oversized content to fit, keeping structure and every non-content field', () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    const s = span({
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: big }] }, { role: 'tool', parts: [{ type: 'text', content: big }] }],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: big }] }],
      'gen_ai.usage.input_tokens': 123,
      'gen_ai.session.id': 's',
    })
    expect(spanBytes(s)).toBeGreaterThan(CLS_MAX_LOG_BYTES)
    expect(limitSpanSize(s)).toBe(true)
    expect(spanBytes(s)).toBeLessThan(CLS_MAX_LOG_BYTES)
    const input = s.attributes['gen_ai.input.messages'] as { role: string; parts: { content: string }[] }[]
    expect(input.map((m) => m.role)).toEqual(['user', 'tool'])
    expect(input[0]!.parts[0]!.content).toMatch(/truncated: span size limit/)
    expect(s.attributes['gen_ai.usage.input_tokens']).toBe(123)
    expect(s.attributes['gen_ai.session.id']).toBe('s')
    expect(s.attributes['agent.custom.span_size_limited']).toBe(true)
  })

  it('drops content that cannot be shortened enough (many tiny strings)', () => {
    const parts = Array.from({ length: 200_000 }, () => ({ type: 'text', content: 'x'.repeat(40) }))
    const s = span({ 'gen_ai.input.messages': [{ role: 'user', parts }], 'gen_ai.usage.input_tokens': 1 })
    expect(limitSpanSize(s)).toBe(true)
    expect(s.attributes['gen_ai.input.messages']).toBeUndefined()
    expect(s.attributes['gen_ai.usage.input_tokens']).toBe(1)
  })
})
