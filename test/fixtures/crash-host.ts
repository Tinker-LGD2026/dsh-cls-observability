/**
 * Fault-injection host: journals and sends spans to a local OTLP endpoint, then keeps
 * running until the test kills it. Prints "ready <n>" once every span is pushed.
 *   node test/fixtures/crash-host.ts <outbox-dir> <endpoint> <count>
 */
import { Journal } from '../../src/journal.ts'
import { Outbox } from '../../src/outbox.ts'
import { ExportQueue } from '../../src/queue.ts'
import { SpanKind } from '../../src/otlp/types.ts'

const [dir, endpoint, countArg] = process.argv.slice(2) as [string, string, string]
const count = Number(countArg)
const header = { resource: { 'service.name': 'crash-host' }, scope: { name: 'crash-host', version: '0' } }
const outbox = new Outbox(dir)
outbox.ensure()
const queue = new ExportQueue({
  exporter: { endpoint, timeoutMs: 30_000, gzip: true },
  resource: header.resource,
  scope: header.scope,
  maxBatchSpans: 10,
  flushIntervalMs: 50,
  eagerDelayMs: 1,
  maxQueueSpans: 10_000,
  outbox,
  journal: new Journal(dir, header, () => {}),
  log: () => {},
})
queue.start()
for (let i = 1; i <= count; i++) {
  queue.push({
    traceId: '0'.repeat(32),
    spanId: i.toString(16).padStart(16, '0'),
    name: `span ${i}`,
    kind: SpanKind.Internal,
    startNs: BigInt(Date.now()) * 1_000_000n,
    endNs: BigInt(Date.now()) * 1_000_000n,
    attributes: { i },
  })
}
process.stdout.write(`ready ${count}\n`)
setInterval(() => {}, 1_000)
