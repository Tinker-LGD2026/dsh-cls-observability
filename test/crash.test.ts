import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from '../src/journal.ts'
import { Outbox } from '../src/outbox.ts'
import { ExportQueue } from '../src/queue.ts'
import { decode } from './otlp-schema.ts'

const dirs: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const s of servers.splice(0)) s.close()
})

/** A slow OTLP endpoint that records every span id it accepts. */
async function collector(delayMs: number) {
  const received: string[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      setTimeout(() => {
        const body = Buffer.concat(chunks)
        const msg = decode(req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body)
        for (const rs of msg.resource_spans) for (const ss of rs.scope_spans) for (const s of ss.spans) received.push(Buffer.from(s.span_id, 'base64').toString('hex'))
        res.writeHead(200).end()
      }, delayMs)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { received, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/traces` }
}

describe('fault injection: host killed with SIGKILL', () => {
  it('delivers every journaled span after the host is killed mid-stream', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-crash-'))
    dirs.push(dir)
    const total = 200
    const { received, endpoint } = await collector(150)

    const host = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'crash-host.ts'), dir, endpoint, String(total)], { stdio: ['ignore', 'pipe', 'inherit'] })
    await new Promise<void>((resolve, reject) => {
      host.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve() })
      host.on('exit', (c) => reject(new Error(`host exited early (${String(c)})`)))
    })
    // Let a few batches go out, then kill without any chance to flush.
    await new Promise((r) => setTimeout(r, 400))
    host.kill('SIGKILL')
    await new Promise((r) => host.on('exit', r))
    const beforeRestart = new Set(received).size
    expect(beforeRestart).toBeLessThan(total)
    expect(readdirSync(dir).some((f) => f.includes('.wal'))).toBe(true)

    // The next start recovers the dead host's journal and delivers the rest.
    const header = { resource: { 'service.name': 'next' }, scope: { name: 'next', version: '0' } }
    const outbox = new Outbox(dir)
    const queue = new ExportQueue({
      exporter: { endpoint, timeoutMs: 10_000, gzip: true },
      resource: header.resource, scope: header.scope, maxBatchSpans: 100, flushIntervalMs: 50, eagerDelayMs: 1,
      maxQueueSpans: 10_000, outbox, journal: new Journal(dir, header, () => {}), log: () => {},
    })
    queue.start()
    const until = Date.now() + 15_000
    while (new Set(received).size < total && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    await queue.stop(2_000)

    const unique = new Set(received)
    if (process.env.CRASH_VERBOSE) console.log(`before kill: ${beforeRestart}/${total} delivered; after restart: ${unique.size}/${total}, duplicates ${received.length - unique.size}`)
    expect(unique.size).toBe(total)
    // Duplicates only for the batch in flight when the host died (10 spans per batch).
    expect(received.length - unique.size).toBeLessThanOrEqual(10)
    expect(readdirSync(dir)).toEqual([])
  }, 30_000)
})
