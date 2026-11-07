import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal, readJournal, recoverJournals } from '../src/journal.ts'
import { Outbox } from '../src/outbox.ts'
import { ExportQueue } from '../src/queue.ts'
import { SpanKind, double, type SpanRecord } from '../src/otlp/types.ts'
import { decode } from './otlp-schema.ts'

const dirs: string[] = []
const tempDir = () => { const d = mkdtempSync(path.join(tmpdir(), 'agentobs-journal-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const header = { resource: { 'service.name': 'test' }, scope: { name: 'test', version: '0' } }
const span = (i: number): SpanRecord => ({
  traceId: '0'.repeat(32),
  spanId: i.toString(16).padStart(16, '0'),
  name: `s${i}`,
  kind: SpanKind.Internal,
  startNs: 1_700_000_000_000_000_000n + BigInt(i),
  endNs: 1_700_000_000_000_000_500n + BigInt(i),
  attributes: { n: i, big: 12345678901234567890n, d: double(1.5), list: ['a', 'b'], obj: { k: 'v' } },
  events: [{ timeNs: 1n, name: 'e' }],
})
const files = (dir: string, suffix: string) => readdirSync(dir).filter((f) => f.includes(suffix))
const decodeFile = (file: string) => decode(gunzipSync(readFileSync(file))).resource_spans[0].scope_spans[0].spans as { span_id: string }[]

describe('write-ahead journal', () => {
  it('journals spans before they are sent and forgets them once acknowledged', () => {
    const dir = tempDir()
    const j = new Journal(dir, header, () => {})
    const spans = [span(1), span(2), span(3)]
    for (const s of spans) j.append(s)
    const [file] = files(dir, '.wal')
    expect(file).toMatch(new RegExp(`\\.wal\\.sending-${process.pid}$`))
    j.ack([spans[0]!, spans[2]!])
    const { header: h, spans: live } = readJournal(readFileSync(path.join(dir, file!), 'utf8'))
    expect(h).toEqual(header)
    expect(live).toEqual([spans[1]])
  })

  it('round-trips bigint times and typed attributes exactly', () => {
    const dir = tempDir()
    const j = new Journal(dir, header, () => {})
    j.append(span(7))
    const [file] = files(dir, '.wal')
    expect(readJournal(readFileSync(path.join(dir, file!), 'utf8')).spans[0]).toEqual(span(7))
  })

  it('ignores a torn last line left by a crash mid-write', () => {
    const dir = tempDir()
    const j = new Journal(dir, header, () => {})
    j.append(span(1))
    j.append(span(2))
    const [file] = files(dir, '.wal')
    const full = path.join(dir, file!)
    writeFileSync(full, readFileSync(full, 'utf8') + '{"s":{"traceId":"00')
    expect(readJournal(readFileSync(full, 'utf8')).spans.map((s) => s.name)).toEqual(['s1', 's2'])
  })

  it('discard deletes the journal; release keeps unsent spans for the next start', () => {
    const a = tempDir()
    const ja = new Journal(a, header, () => {})
    ja.append(span(1))
    ja.discard()
    expect(readdirSync(a)).toEqual([])
    ja.append(span(2))
    expect(readdirSync(a)).toEqual([])

    const b = tempDir()
    const jb = new Journal(b, header, () => {})
    jb.append(span(1))
    jb.release()
    expect(files(b, '.wal')).toEqual([expect.stringMatching(/\.wal$/)])
  })

  it('a dead writer\'s journal becomes outbox files holding exactly the unacknowledged spans', () => {
    const dir = tempDir()
    const outbox = new Outbox(dir)
    const j = new Journal(dir, header, () => {})
    const spans = Array.from({ length: 600 }, (_, i) => span(i + 1))
    for (const s of spans) j.append(s)
    j.ack(spans.slice(0, 50))
    // Simulate the writer dying: its claim names a pid that no longer exists.
    const [file] = files(dir, '.wal')
    renameSync(path.join(dir, file!), path.join(dir, file!.replace(/sending-\d+$/, 'sending-999999999')))
    expect(outbox.recoverStaleClaims()).toBe(1)
    expect(recoverJournals(outbox)).toBe(550)
    expect(files(dir, '.wal')).toEqual([])
    const sent = outbox.pending().flatMap((f) => decodeFile(f).map((s) => s.span_id))
    expect(sent).toHaveLength(550)
    expect(new Set(sent).size).toBe(550)
  })

  it('leaves a live writer\'s journal alone', () => {
    const dir = tempDir()
    const j = new Journal(dir, header, () => {})
    j.append(span(1))
    expect(recoverJournals(new Outbox(dir))).toBe(0)
    expect(files(dir, '.wal')).toHaveLength(1)
  })

  it('disables itself on an IO failure instead of throwing into the host', () => {
    const dir = tempDir()
    const warnings: string[] = []
    const j = new Journal(path.join(dir, 'missing', 'nested'), header, (_l, m) => warnings.push(m))
    expect(() => j.append(span(1))).not.toThrow()
    expect(j.active).toBe(false)
    expect(warnings.join()).toMatch(/journal disabled/)
  })
})

describe('queue with a journal', () => {
  const okFetch = (async () => new Response('', { status: 200 })) as unknown as typeof fetch
  const downFetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
  const queue = (dir: string, fetchImpl: typeof fetch, maxQueueSpans = 10_000) => {
    const outbox = new Outbox(dir)
    const journal = new Journal(dir, header, () => {})
    return {
      outbox,
      journal,
      q: new ExportQueue({
        exporter: { endpoint: 'https://e.test', timeoutMs: 1000, gzip: true },
        resource: header.resource, scope: header.scope, maxBatchSpans: 4, flushIntervalMs: 60_000, eagerDelayMs: 1,
        maxQueueSpans, outbox, journal, log: () => {}, fetchImpl,
      }),
    }
  }

  it('acknowledges delivered spans so the journal stays empty in steady state', async () => {
    const dir = tempDir()
    const { q } = queue(dir, okFetch)
    q.start()
    for (let i = 1; i <= 10; i++) q.push(span(i))
    await q.flush(1000)
    const [file] = files(dir, '.wal')
    expect(readJournal(readFileSync(path.join(dir, file!), 'utf8')).spans).toEqual([])
    await q.stop(500)
    expect(readdirSync(dir)).toEqual([])
  })

  it('moves spans to the outbox instead of dropping them when memory is full', () => {
    const dir = tempDir()
    const { q, outbox } = queue(dir, downFetch, 8)
    for (let i = 1; i <= 20; i++) q.push(span(i))
    expect(q.stats.dropped).toBe(0)
    expect(q.stats.pending).toBeLessThanOrEqual(8)
    const spilled = outbox.pending().flatMap((f) => decodeFile(f))
    expect(spilled.length + q.stats.pending).toBe(20)
  })

  it('keeps unsent spans journaled when the shutdown spill fails', async () => {
    const dir = tempDir()
    const { q, outbox } = queue(dir, downFetch)
    for (let i = 1; i <= 3; i++) q.push(span(i))
    // Make the spill fail: outbox over capacity.
    ;(outbox as unknown as { maxBytes: number }).maxBytes = 0
    await q.stop(100)
    const [file] = files(dir, '.wal')
    expect(file).toMatch(/\.wal$/)
    expect(readJournal(readFileSync(path.join(dir, file!), 'utf8')).spans).toHaveLength(3)
  })
})
