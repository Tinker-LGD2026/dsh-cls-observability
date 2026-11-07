import { describe, expect, it } from 'vitest'
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

  it('bounds memory by dropping the oldest spans', () => {
    const { queue } = queueWith(() => 200)
    for (let i = 0; i < 150; i++) queue.push(span(i))
    expect(queue.stats.pending).toBe(100)
    expect(queue.stats.dropped).toBe(50)
  })
})
