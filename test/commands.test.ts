import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Journal } from '../src/journal.ts'
import { Outbox } from '../src/outbox.ts'
import { encodeGzipBody } from '../src/exporter.ts'
import { SpanKind } from '../src/otlp/types.ts'

const dirs: string[] = []
const servers: Server[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  for (const s of servers.splice(0)) s.close()
})

async function endpoint() {
  let requests = 0
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { requests++; res.writeHead(200).end() }) })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { count: () => requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/traces` }
}

const span = (i: number) => ({ traceId: '0'.repeat(32), spanId: i.toString(16).padStart(16, '0'), name: 's', kind: SpanKind.Internal, startNs: 1n, endNs: 2n, attributes: {} })
const header = { resource: {}, scope: { name: 't', version: '0' } }

function run(args: string[], env: Record<string, string>, signalAfterMs?: number) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'index.ts'), ...args], {
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), CLS_AGENTOBS_ENABLED: 'true', CLS_AGENTOBS_ALLOW_HTTP: 'true', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  if (signalAfterMs !== undefined) setTimeout(() => child.kill('SIGTERM'), signalAfterMs)
  return new Promise<{ code: number | null; stderr: string }>((resolve) => child.on('exit', (code) => resolve({ code, stderr })))
}

describe('operator commands', () => {
  it('--flush delivers outbox files and a dead process\'s journal, then exits 0', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-flush-'))
    dirs.push(dir)
    const outbox = new Outbox(dir)
    outbox.spillSync(encodeGzipBody({ ...header, spans: [span(1)] }))
    const journal = new Journal(dir, header, () => {})
    journal.append(span(2))
    journal.release()
    const server = await endpoint()
    const result = await run(['--flush', dir], { CLS_AGENTOBS_ENDPOINT: server.url })
    expect(result.stderr).toMatch(/flush: delivered 2 files, 0 left/)
    expect(result.code).toBe(0)
    expect(server.count()).toBe(2)
    expect(readdirSync(dir)).toEqual([])
  }, 20_000)

  it('--flush exits 1 when the destination is down and keeps the files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-flush-'))
    dirs.push(dir)
    new Outbox(dir).spillSync(encodeGzipBody({ ...header, spans: [span(1)] }))
    const result = await run(['--flush', dir], { CLS_AGENTOBS_ENDPOINT: 'http://127.0.0.1:9/v1/traces', CLS_AGENTOBS_EXPORT_TIMEOUT_MS: '1000', CLS_AGENTOBS_FLUSH_ATTEMPTS: '1' })
    expect(result.code).toBe(1)
    expect(new Outbox(dir).pending()).toHaveLength(1)
  }, 60_000)

  it('--relay keeps delivering new files and stops cleanly on SIGTERM', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-relay-'))
    dirs.push(dir)
    const outbox = new Outbox(dir)
    outbox.ensure()
    const server = await endpoint()
    const running = run(['--relay', dir], { CLS_AGENTOBS_ENDPOINT: server.url, CLS_AGENTOBS_RELAY_INTERVAL_MS: '100' }, 1500)
    await new Promise((r) => setTimeout(r, 400))
    outbox.spillSync(encodeGzipBody({ ...header, spans: [span(1)] }))
    await new Promise((r) => setTimeout(r, 400))
    outbox.spillSync(encodeGzipBody({ ...header, spans: [span(2)] }))
    const result = await running
    expect(result.code).toBe(0)
    expect(server.count()).toBe(2)
    expect(outbox.pending()).toHaveLength(0)
  }, 20_000)

  it('refuses to run without configuration', async () => {
    const result = await run(['--flush'], { CLS_AGENTOBS_ENABLED: 'false' })
    expect(result.code).toBe(2)
  }, 20_000)
})
