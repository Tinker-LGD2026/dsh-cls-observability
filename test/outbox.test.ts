import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { deliverOutbox } from '../src/deliver.ts'
import { Outbox } from '../src/outbox.ts'
import { ExportQueue } from '../src/queue.ts'
import { SpanKind, type SpanRecord } from '../src/otlp/types.ts'
import { decode } from './otlp-schema.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'agentobs-outbox-')); dirs.push(d); return d }

const span = (i: number): SpanRecord => ({
  traceId: '0123456789abcdef0123456789abcdef',
  spanId: (i + 1).toString(16).padStart(16, '0'),
  name: `s${i}`, kind: SpanKind.Internal, startNs: 1n, endNs: 2n, attributes: {},
})

function fakeFetch(status: () => number, bodies: Uint8Array[] = []) {
  return (async (_u: string, init: RequestInit) => {
    bodies.push(init.body as Uint8Array)
    return new Response('', { status: status() })
  }) as unknown as typeof fetch
}

function queue(outbox: Outbox, fetchImpl: typeof fetch) {
  return new ExportQueue({
    exporter: { endpoint: 'https://example.test/v1/traces', timeoutMs: 1000, gzip: true },
    resource: { 'service.name': 't' }, scope: { name: 't', version: '1' },
    maxBatchSpans: 100, flushIntervalMs: 60_000, maxQueueSpans: 1000, outbox, log: () => {}, fetchImpl,
  })
}

describe('outbox', () => {
  it('spills undeliverable spans at stop and a later instance delivers them', async () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const down = queue(outbox, fakeFetch(() => 503))
    for (let i = 0; i < 3; i++) down.push(span(i))
    const stopped = await down.stop(300)
    expect(stopped.delivered).toBe(false)
    expect(stopped.spillFile).toBeDefined()
    expect(down.stats.spilled).toBe(3)
    expect(down.stats.dropped).toBe(0)
    expect(outbox.pending()).toHaveLength(1)

    const sent: Uint8Array[] = []
    const up = queue(outbox, fakeFetch(() => 200, sent))
    up.start()
    await new Promise((r) => setTimeout(r, 100))
    await up.stop(1000)
    expect(up.stats.recovered).toBe(1)
    expect(outbox.pending()).toHaveLength(0)
    const decoded = decode(gunzipSync(sent[0]!))
    expect(decoded.resource_spans[0].scope_spans[0].spans).toHaveLength(3)
  })

  it('spills first, notifies before any await, then delivers the spill in-process', async () => {
    const outbox = new Outbox(tempDir())
    const q = queue(outbox, fakeFetch(() => 200))
    q.push(span(0))
    let pendingAtNotify = -1
    const stopping = q.stop(1000, () => { pendingAtNotify = outbox.pending().length })
    // onSpill ran synchronously inside stop(), before its first await.
    expect(pendingAtNotify).toBe(1)
    const stopped = await stopping
    expect(stopped.delivered).toBe(true)
    expect(q.stats.recovered).toBe(1)
    expect(outbox.pending()).toHaveLength(0)
  })

  it('in-process flush and a concurrent deliverer never send the same file twice', async () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const sent: Uint8Array[] = []
    const slow = (async (_u: string, init: RequestInit) => {
      sent.push(init.body as Uint8Array)
      await new Promise((r) => setTimeout(r, 50))
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const q = queue(outbox, slow)
    for (let i = 0; i < 3; i++) q.push(span(i))
    await Promise.all([
      q.stop(2000, () => { void deliverOutbox(dir, { endpoint: 'https://e.test', timeoutMs: 1000, gzip: true }, () => {}, { attempts: 1, fetchImpl: slow }) }),
    ])
    await new Promise((r) => setTimeout(r, 200))
    expect(sent).toHaveLength(1)
    expect(outbox.pending()).toHaveLength(0)
  })

  it('does not duplicate a batch that is in flight when stop() begins', async () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const spanIdsSent: string[] = []
    const slow = (async (_u: string, init: RequestInit) => {
      const decoded = decode(gunzipSync(init.body as Uint8Array))
      for (const s of decoded.resource_spans[0].scope_spans[0].spans) spanIdsSent.push(Buffer.from(s.span_id, 'base64').toString('hex'))
      await new Promise((r) => setTimeout(r, 80))
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const q = queue(outbox, slow)
    q.start()
    for (let i = 0; i < 4; i++) q.push(span(i), i === 3)
    await new Promise((r) => setTimeout(r, 20)) // the urgent push has started a request
    q.push(span(4)) // arrives after the in-flight batch was taken
    await q.stop(2000, () => {
      void deliverOutbox(dir, { endpoint: 'https://e.test', timeoutMs: 1000, gzip: true }, () => {}, { attempts: 1, fetchImpl: slow })
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(spanIdsSent.sort()).toEqual([0, 1, 2, 3, 4].map((i) => span(i).spanId).sort())
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('leaves the outbox entirely to a detached deliverer once one is started', async () => {
    const outbox = new Outbox(tempDir())
    let calls = 0
    const q = queue(outbox, fakeFetch(() => { calls++; return 200 }))
    q.push(span(0))
    const stopped = await q.stop(500, () => true)
    expect(calls).toBe(0)
    expect(outbox.pending()).toHaveLength(1)
    expect(stopped.spillFile).toBeDefined()
  })

  it('hands an in-flight batch over to other senders when its request fails', async () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const failing = (async () => {
      await new Promise((r) => setTimeout(r, 50))
      return new Response('', { status: 503 })
    }) as unknown as typeof fetch
    const q = queue(outbox, failing)
    q.start()
    q.push(span(0), true)
    await new Promise((r) => setTimeout(r, 10))
    await q.stop(200)
    // A retry still in flight when stop() returns releases its claim once its request settles.
    await new Promise((r) => setTimeout(r, 150))
    // Not lost: the released in-flight batch is a pending file for the deliverer / next start.
    expect(outbox.pending()).toHaveLength(1)
  })

  it('lets exactly one sender claim a file and releases claims of dead processes', () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const file = outbox.spillSync(new Uint8Array([1, 2, 3]))!
    const claimed = outbox.claim(file)
    expect(claimed).toBeDefined()
    expect(outbox.claim(file)).toBeUndefined()
    expect(outbox.pending()).toHaveLength(0)
    // Simulate a crashed sender: re-tag the claim with a pid that cannot exist.
    renameSync(claimed!, `${file}.sending-999999`)
    expect(outbox.recoverStaleClaims()).toBe(1)
    expect(outbox.pending()).toEqual([file])
  })

  it('waits for a live host holding a file, then sends it once the host has exited', async () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)'])
    const file = outbox.spillSync(new Uint8Array([9]))!
    renameSync(file, `${file}.sending-${host.pid}`)
    const bodies: Uint8Array[] = []
    const result = await deliverOutbox(dir, { endpoint: 'https://e.test', timeoutMs: 1000, gzip: true }, () => {}, { attempts: 1, fetchImpl: fakeFetch(() => 200, bodies), claimWaitMs: 5000, pollMs: 25 })
    expect(result).toEqual({ delivered: 1, remaining: 0 })
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('stops waiting for a live host at the deadline and leaves its file in place', async () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'])
    const file = outbox.spillSync(new Uint8Array([9]))!
    renameSync(file, `${file}.sending-${host.pid}`)
    const result = await deliverOutbox(dir, { endpoint: 'https://e.test', timeoutMs: 1000, gzip: true }, () => {}, { attempts: 1, fetchImpl: fakeFetch(() => 200), claimWaitMs: 100, pollMs: 25 })
    host.kill()
    expect(result.delivered).toBe(0)
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('deliverOutbox sends every pending file and leaves failures in place', async () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    outbox.spillSync(new Uint8Array([1]))
    outbox.spillSync(new Uint8Array([2]))
    const ok = await deliverOutbox(dir, { endpoint: 'https://e.test', timeoutMs: 1000, gzip: true }, () => {}, { attempts: 1, fetchImpl: fakeFetch(() => 200) })
    expect(ok).toEqual({ delivered: 2, remaining: 0 })
    outbox.spillSync(new Uint8Array([3]))
    const fail = await deliverOutbox(dir, { endpoint: 'https://e.test', timeoutMs: 1000, gzip: true }, () => {}, { attempts: 1, fetchImpl: fakeFetch(() => 401) })
    expect(fail).toEqual({ delivered: 0, remaining: 1 })
    expect(readdirSync(dir).filter((f) => f.includes('.sending-'))).toHaveLength(0)
  })
})
