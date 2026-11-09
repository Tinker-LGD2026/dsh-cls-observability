import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyStatus } from '../src/exporter.ts'
import { Outbox } from '../src/outbox.ts'
import { ExportQueue } from '../src/queue.ts'
import { SpanKind, type SpanRecord } from '../src/otlp/types.ts'

const span = (i: number): SpanRecord => ({
  traceId: '0123456789abcdef0123456789abcdef',
  spanId: (i + 1).toString(16).padStart(16, '0'),
  name: `s${i}`,
  kind: SpanKind.Internal,
  startNs: 1n,
  endNs: 2n,
  attributes: { bad: i === 2 },
})

function queueWith(responder: (body: Uint8Array, call: number) => number) {
  let calls = 0
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const status = responder(init.body as Uint8Array, calls++)
    return new Response(status === 200 ? '' : 'nope', { status })
  }) as unknown as typeof fetch
  const logs: string[] = []
  const queue = new ExportQueue({
    exporter: { endpoint: 'https://example.test/v1/traces', timeoutMs: 1000, gzip: false },
    resource: {},
    scope: { name: 't', version: '1' },
    maxBatchSpans: 10,
    flushIntervalMs: 10_000,
    maxQueueSpans: 100,
    log: (_l, m) => logs.push(m),
    fetchImpl,
  })
  return { queue, logs, calls: () => calls }
}

describe('ExportQueue', () => {
  it('delivers on success', async () => {
    const { queue } = queueWith(() => 200)
    for (let i = 0; i < 5; i++) queue.push(span(i))
    expect(await queue.flush(1000)).toBe(true)
    expect(queue.stats.exported).toBe(5)
  })

  it('keeps data on transient failure and retries', async () => {
    const { queue } = queueWith((_b, call) => (call < 2 ? 503 : 200))
    queue.push(span(0))
    expect(await queue.flush(5000)).toBe(true)
    expect(queue.stats.exported).toBe(1)
    expect(queue.stats.retried).toBe(2)
  })

  it('isolates a rejected span and delivers the rest', async () => {
    // A batch containing span #2 is rejected with 400; singles other than #2 succeed.
    const badSpanId = Buffer.from(span(2).spanId, 'hex')
    const { queue } = queueWith((body) => (Buffer.from(body).includes(badSpanId) ? 400 : 200))
    for (let i = 0; i < 4; i++) queue.push(span(i))
    expect(await queue.flush(2000)).toBe(true)
    expect(queue.stats.rejected).toBe(1)
    expect(queue.stats.exported).toBe(3)
  })

  it('pauses on auth failure without dropping data', async () => {
    const { queue, logs } = queueWith(() => 401)
    queue.push(span(0))
    expect(await queue.flush(300)).toBe(false)
    expect(queue.stats.pending).toBe(1)
    expect(queue.stats.dropped).toBe(0)
    expect(logs.join()).toMatch(/unauthorized/)
  })

  it('treats 404 (wrong topic) as configuration: keeps every span and sends no per-span retries', async () => {
    const { queue, logs, calls } = queueWith(() => 404)
    for (let i = 0; i < 5; i++) queue.push(span(i))
    expect(await queue.flush(300)).toBe(false)
    expect(calls()).toBe(1)
    expect(queue.stats.pending).toBe(5)
    expect(queue.stats.rejected).toBe(0)
    expect(logs.join()).toMatch(/destination not found/)
  })

  it('caps a huge Retry-After instead of overflowing the timer', () => {
    expect(classifyStatus(429, '', '99999999999')).toMatchObject({ kind: 'retryable', retryAfterMs: 300_000 })
    expect(classifyStatus(503, '', new Date(Date.now() + 365 * 86_400_000).toUTCString())).toMatchObject({ retryAfterMs: 300_000 })
  })

  it('spills at exit in files of at most one batch', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-q-'))
    try {
      const outbox = new Outbox(dir)
      const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
      const queue = new ExportQueue({
        exporter: { endpoint: 'https://example.test/v1/traces', timeoutMs: 200, gzip: false },
        resource: {}, scope: { name: 't', version: '1' }, maxBatchSpans: 10, flushIntervalMs: 10_000, maxQueueSpans: 1000,
        outbox, log: () => {}, fetchImpl,
      })
      for (let i = 0; i < 35; i++) queue.push(span(i))
      const result = await queue.stop(100)
      expect(result.spilled).toBe(true)
      expect(outbox.pending()).toHaveLength(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds memory by bytes too, moving the oldest spans to the outbox', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-qb-'))
    try {
      const outbox = new Outbox(dir)
      const queue = new ExportQueue({
        exporter: { endpoint: 'https://example.test/v1/traces', timeoutMs: 200, gzip: false },
        resource: {}, scope: { name: 't', version: '1' }, maxBatchSpans: 10, flushIntervalMs: 10_000, maxQueueSpans: 1000,
        maxQueueBytes: 50_000, outbox, log: () => {}, fetchImpl: (async () => new Response('', { status: 503 })) as unknown as typeof fetch,
      })
      const big = (i: number) => ({ ...span(i), attributes: { 'gen_ai.output.messages': 'x'.repeat(10_000) } })
      for (let i = 0; i < 20; i++) queue.push(big(i))
      expect(queue.stats.pending).toBeLessThanOrEqual(5)
      expect(queue.stats.dropped).toBe(0)
      expect(queue.stats.spilled).toBe(20 - queue.stats.pending)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('bounds memory by dropping the oldest spans', () => {
    const { queue } = queueWith(() => 200)
    for (let i = 0; i < 150; i++) queue.push(span(i))
    expect(queue.stats.pending).toBe(100)
    expect(queue.stats.dropped).toBe(50)
  })
})
