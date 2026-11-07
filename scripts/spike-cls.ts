/**
 * DEV ONLY. Verifies how CLS stores OTLP spans:
 *  - string[] / int / double / bool / kvlist-array / JSON-string attributes
 *  - Span kind / status / events / links representation
 *  - duplicate spanID behaviour
 * Usage: node scripts/spike-cls.ts
 */
import { randomBytes } from 'node:crypto'
import { exportBatch } from '../src/exporter.ts'
import { double, SpanKind, StatusCode, type SpanRecord } from '../src/otlp/types.ts'
import { loadDevSecrets } from './dev-secrets.ts'
import { searchSpans } from './cls-api.ts'

const secrets = loadDevSecrets()
const endpoint = `https://${secrets.region}.cls.tencentcs.com/v1/traces`
const hex = (n: number) => randomBytes(n).toString('hex')
const nowNs = () => BigInt(Date.now()) * 1_000_000n

const traceId = hex(16)
const sessionId = `spike-${traceId.slice(0, 8)}`
const ids = { entry: hex(8), agent: hex(8), step: hex(8), chat: hex(8), tool: hex(8) }
const t0 = nowNs() - 5_000_000_000n
const ms = (n: number) => BigInt(n) * 1_000_000n

const common = {
  'gen_ai.agent.type': 'deepseek-harness',
  'gen_ai.agent.name': 'main',
  'gen_ai.agent.id': sessionId,
  'gen_ai.session.id': sessionId,
  'gen_ai.turn.id': `${sessionId}:t1`,
  'gen_ai.entry.type': 'CLI',
  'gen_ai.entry.platform': 'terminal',
  'gen_ai.system': 'deepseek',
  'agent.custom.spike': 'dsh-cls-observability',
}
const messages = [{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]

const spans: SpanRecord[] = [
  { traceId, spanId: ids.entry, name: 'enter_application', kind: SpanKind.Server, startNs: t0, endNs: t0 + ms(4000),
    attributes: { ...common, 'gen_ai.span.kind': 'entry', 'gen_ai.operation.name': 'enter_application' }, status: { code: StatusCode.Ok } },
  { traceId, spanId: ids.agent, parentSpanId: ids.entry, name: 'invoke_agent main', kind: SpanKind.Internal, startNs: t0 + ms(1), endNs: t0 + ms(3990),
    attributes: { ...common, 'gen_ai.span.kind': 'agent', 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.message_count': 3, 'gen_ai.agent.tool_call_count': 1 } },
  { traceId, spanId: ids.step, parentSpanId: ids.agent, name: 'react step 1', kind: SpanKind.Internal, startNs: t0 + ms(2), endNs: t0 + ms(3000),
    attributes: { ...common, 'gen_ai.span.kind': 'step', 'gen_ai.operation.name': 'react', 'gen_ai.step.id': `${sessionId}:t1:s1`, 'gen_ai.react.round': 1, 'gen_ai.react.finish_reason': 'tool_calls' } },
  { traceId, spanId: ids.chat, parentSpanId: ids.step, name: 'chat deepseek-chat', kind: SpanKind.Client, startNs: t0 + ms(3), endNs: t0 + ms(1500),
    attributes: {
      ...common,
      'gen_ai.span.kind': 'chat', 'gen_ai.operation.name': 'chat', 'gen_ai.step.id': `${sessionId}:t1:s1`,
      'gen_ai.provider.name': 'deepseek', 'gen_ai.request.model': 'deepseek-chat', 'gen_ai.response.model': 'deepseek-chat',
      'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.request.temperature': double(1),
      'gen_ai.request.top_p': 0.9,
      'gen_ai.response.time_to_first_token_ms': 320,
      'gen_ai.chat.duration_ms': 1497,
      'gen_ai.usage.input_tokens': 1200, 'gen_ai.usage.output_tokens': 80, 'gen_ai.usage.total_tokens': 1280,
      'gen_ai.usage.cache_read.input_tokens': 1000, 'gen_ai.usage.cache_miss.input_tokens': 200, 'gen_ai.usage.reasoning_output_tokens': 10,
      'gen_ai.input.messages': messages,                          // probe A: native OTLP array of kvlist
      'agent.custom.probe_json_string': JSON.stringify(messages),  // probe B: JSON string
      'agent.custom.probe_bool': true,
      'agent.custom.dup': 1,
    },
    events: [{ timeNs: t0 + ms(400), name: 'retry', attributes: { delayMs: 500 } }],
  },
  { traceId, spanId: ids.tool, parentSpanId: ids.step, name: 'execute_tool read', kind: SpanKind.Internal, startNs: t0 + ms(1600), endNs: t0 + ms(1650),
    attributes: { ...common, 'gen_ai.span.kind': 'tool', 'gen_ai.operation.name': 'execute_tool', 'gen_ai.step.id': `${sessionId}:t1:s1`,
      'gen_ai.tool.name': 'read', 'gen_ai.tool.type': 'function', 'gen_ai.tool.call.id': 'call_spike', 'gen_ai.tool.call.duration_ms': 50,
      'gen_ai.tool.call.arguments': { file_path: 'package.json' } },
    status: { code: StatusCode.Error, message: 'tool execution failed' },
    links: [{ traceId, spanId: ids.agent }],
  },
]

const resource = {
  'service.name': 'deepseek-harness', 'service.version': '0.2.2-rc.1', 'host.name': 'spike-host', 'process.pid': process.pid,
  'telemetry.sdk.name': 'dsh-cls-observability', 'telemetry.sdk.language': 'nodejs', 'telemetry.sdk.version': '0.1.0',
}
const config = {
  endpoint, topicId: secrets.topicId, timeoutMs: 15_000, gzip: true,
  credentials: () => ({ secretId: secrets.secretId, secretKey: secrets.secretKey }),
}

const first = await exportBatch(config, { resource, scope: { name: 'dsh-cls-observability', version: '0.1.0' }, spans })
console.log('export #1:', first.kind, 'status' in first ? first.status : '', first.kind !== 'ok' ? first.error : '')
const chat = spans[3]!
const dup = await exportBatch(config, { resource, scope: { name: 'dsh-cls-observability', version: '0.1.0' }, spans: [{ ...chat, attributes: { ...chat.attributes, 'agent.custom.dup': 2 } }] })
console.log('export #2 (duplicate chat spanID):', dup.kind)
if (first.kind !== 'ok') process.exit(1)

console.log('traceID:', traceId)
const from = Date.now() - 10 * 60_000
let stored: Awaited<ReturnType<typeof searchSpans>> = []
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 10_000))
  try {
    stored = (await searchSpans(secrets, from, Date.now() + 60_000, `traceID:"${traceId}"`)).filter((s) => s.traceID === traceId)
  } catch (error) {
    console.log('search error:', (error as Error).message)
    stored = (await searchSpans(secrets, from, Date.now() + 60_000)).filter((s) => s.traceID === traceId)
  }
  console.log(`poll ${i + 1}: ${stored.length} stored spans`)
  if (stored.length >= 6) break
}

const byKind = (k: string) => stored.filter((s) => s.attribute['gen_ai.span.kind'] === k)
const typeOf = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
const chats = byKind('chat')
console.log('\n== top-level keys ==', Object.keys(stored[0]?.raw ?? {}).join(', '))
console.log('== kinds/status ==')
for (const s of stored) console.log(`  ${String(s.attribute['gen_ai.span.kind']).padEnd(6)} kind=${s.kind} status=${s.statusCode ?? ''} statusMessage=${String(s.raw.statusMessage ?? '')} parent=${s.parentSpanID ?? ''}`)
console.log('== duplicate chat spanID rows ==', chats.length, chats.map((c) => c.attribute['agent.custom.dup']))
const c = chats[0]
if (c) {
  for (const key of ['gen_ai.response.finish_reasons', 'gen_ai.input.messages', 'agent.custom.probe_json_string', 'gen_ai.request.temperature', 'gen_ai.request.top_p', 'gen_ai.usage.input_tokens', 'agent.custom.probe_bool']) {
    const v = c.attribute[key]
    console.log(`  ${key}: type=${typeOf(v)} value=${JSON.stringify(v)}`)
  }
  console.log('  logs:', JSON.stringify(c.raw.logs))
}
const tool = byKind('tool')[0]
if (tool) {
  console.log('  tool.arguments:', typeOf(tool.attribute['gen_ai.tool.call.arguments']), JSON.stringify(tool.attribute['gen_ai.tool.call.arguments']))
  console.log('  tool.links:', JSON.stringify(tool.raw.links))
}
console.log('  resource:', JSON.stringify(stored[0]?.resource))
console.log('  start/end/duration types:', typeOf(stored[0]?.raw.start), typeOf(stored[0]?.raw.duration), String(stored[0]?.raw.duration))
