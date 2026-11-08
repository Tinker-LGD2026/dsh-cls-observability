/** DEV ONLY. Read a run's spans back from CLS (by the `agent.custom.e2e_run` marker) and check the tree. */
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { DevSecrets } from './dev-secrets.ts'
import { searchSpans, type StoredSpan } from './cls-api.ts'
import { renderTree, type TreeNode } from '../src/tree.ts'
import { fromStored, validateSpans } from '../src/spec-check.ts'

/** Scenario-specific checks on the deduplicated stored spans of the run; true when they pass. */
export type ExtraCheck = (spans: StoredSpan[], info: { duplicates: number }) => boolean

export async function verifyRun(secrets: DevSecrets, runId: string, startedMs: number, outboxDir: string, extra?: ExtraCheck, minPolls = 2): Promise<boolean> {
  let spans: StoredSpan[] = []
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 10_000))
    const window: [number, number] = [startedMs - 60_000, Date.now() + 60_000]
    spans = (await searchSpans(secrets, ...window, `"${runId}"`).catch(() => [] as StoredSpan[]))
      .filter((s) => s.attribute['agent.custom.e2e_run'] === runId)
    if (spans.length === 0) {
      spans = (await searchSpans(secrets, ...window)).filter((s) => s.attribute['agent.custom.e2e_run'] === runId)
    }
    console.log(`poll ${i + 1}: ${spans.length} spans in CLS`)
    if (spans.length > 0 && i >= minPolls - 1) break
  }

  const totalStored = spans.length
  spans = [...new Map(spans.map((s) => [s.spanID, s])).values()]
  const duplicates = totalStored - spans.length
  const nodes: TreeNode[] = spans.map((s) => ({
    spanId: s.spanID,
    ...(s.parentSpanID ? { parentSpanId: s.parentSpanID } : {}),
    name: s.name,
    start: BigInt(String(s.raw.start ?? '0')),
    attributes: s.attribute,
    ...(s.statusCode === 'ERROR' ? { statusError: String(s.raw.statusMessage ?? '') } : {}),
    ...(s.raw.logs && s.raw.logs !== '[]' ? { events: (JSON.parse(String(s.raw.logs)) as { name: string }[]).map((e) => e.name) } : {}),
  }))
  console.log('\n' + renderTree(nodes, true))

  const kinds = new Set(spans.map((s) => String(s.attribute['gen_ai.span.kind'])))
  const ids = new Set(spans.map((s) => s.spanID))
  const orphans = spans.filter((s) => s.parentSpanID && !ids.has(s.parentSpanID))
  const traces = new Set(spans.map((s) => s.traceID))
  const statuses = [...new Set(spans.map((s) => s.statusCode))]
  const entry = spans.find((s) => s.attribute['gen_ai.span.kind'] === 'entry')
  console.log(`\nkinds=${[...kinds].sort().join(',')} traces=${traces.size} spans=${spans.length} duplicates=${duplicates} orphanParents=${orphans.length} statuses=${statuses.join(',')}`)
  console.log(`entry: type=${String(entry?.attribute['gen_ai.entry.type'])} platform=${String(entry?.attribute['gen_ai.entry.platform'])}`)
  console.log(`traceIDs: ${[...traces].join(' ')}`)
  const kindIs = (k: string) => spans.filter((s) => s.attribute['gen_ai.span.kind'] === k)
  const short = (v: unknown) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t === undefined ? '-' : t.length > 90 ? `${t.slice(0, 90)}…` : t }
  console.log('\n== content / naming ==')
  for (const s of kindIs('entry')) {
    console.log(`entry ${s.name} session=${String(s.attribute['gen_ai.session.id']).slice(-8)} in=${short(s.attribute['gen_ai.input.messages'])}`)
    console.log(`      out=${short(s.attribute['gen_ai.output.messages'])}`)
  }
  for (const s of kindIs('agent')) console.log(`agent ${s.name} op=${String(s.attribute['gen_ai.operation.name'])} agent.name=${String(s.attribute['gen_ai.agent.name'])} hasIO=${s.attribute['gen_ai.input.messages'] !== undefined}/${s.attribute['gen_ai.output.messages'] !== undefined}`)
  const chatsInOrder = kindIs('chat').filter((s) => !s.attribute['agent.custom.llm_purpose']).sort((a, b) => String(a.raw.end).localeCompare(String(b.raw.end)))
  for (const s of chatsInOrder) {
    const full = s.attribute['gen_ai.input.messages'] as unknown[] | undefined
    const delta = s.attribute['gen_ai.input.messages_delta'] as unknown[] | undefined
    console.log(`chat  ${String(s.attribute['gen_ai.agent.name']).padEnd(8)} ${full ? `full=${full.length}` : `delta=${delta?.length ?? 'MISSING'}`} total=${String(s.attribute['agent.custom.input_message_count'])} hash=${String(s.attribute['gen_ai.input.messages.hash']).slice(0, 8)} delta=${short(delta ?? full)}`)
  }
  for (const s of kindIs('step')) console.log(`step  ${s.name} op=${String(s.attribute['gen_ai.operation.name'])}`)
  for (const s of kindIs('tool')) console.log(`tool  ${s.name} args=${short(s.attribute['gen_ai.tool.call.arguments'])} result=${short(s.attribute['gen_ai.tool.call.result'])}`)
  const contentOk = kindIs('entry').every((s) => s.attribute['gen_ai.input.messages'] && s.attribute['gen_ai.output.messages'])
    && kindIs('tool').every((s) => s.attribute['gen_ai.tool.call.arguments'] !== undefined && s.attribute['gen_ai.tool.call.result'] !== undefined)
    && kindIs('step').every((s) => /^react round_\d+$/.test(s.name))
    && kindIs('entry').every((s) => !s.parentSpanID)
    && kindIs('chat').filter((s) => s.attribute['agent.custom.llm_purpose']).every((s) => s.attribute['gen_ai.input.messages'] && s.attribute['gen_ai.output.messages'])
    && chatsInOrder.every((s) => (s.attribute['gen_ai.input.messages'] === undefined) !== (s.attribute['gen_ai.input.messages_delta'] === undefined))
    && kindIs('agent').every((s) => s.attribute['gen_ai.agent.scope'] !== 'subagent' || s.attribute['gen_ai.agent.name'] !== 'subagent')
  console.log(`content/naming check: ${contentOk ? 'OK' : 'MISSING'}`)
  const specIssues = validateSpans(spans.map(fromStored), { content: true, complete: true, stored: true })
  console.log(`spec check: ${specIssues.length === 0 ? 'OK' : `${specIssues.length} issues`}`)
  for (const i of specIssues.slice(0, 15)) console.log(`  ${i.span}: ${i.problem}`)
  // Undelivered data only: span files and journals (not the closed-turns ledger).
  const leftover = existsSync(outboxDir) ? readdirSync(outboxDir).filter((f) => f.includes('.otlp.gz') || f.includes('.wal')) : []
  console.log(`outbox leftover files: ${leftover.length}`)
  // One task = one session: a subagent's spans carry the session of the task that spawned it.
  const sessionsPerTrace = new Map<string, Set<string>>()
  for (const s of spans) sessionsPerTrace.set(s.traceID, (sessionsPerTrace.get(s.traceID) ?? new Set()).add(String(s.attribute['gen_ai.session.id'])))
  const oneSession = [...sessionsPerTrace.values()].every((v) => v.size === 1)
  console.log(`session.id per trace: ${oneSession ? 'single' : 'MIXED'}`)
  const extraOk = extra ? extra(spans, { duplicates }) : true
  if (extra) console.log(`scenario check: ${extraOk ? 'OK' : 'FAIL'}`)
  const ok = ['entry', 'agent', 'step', 'chat', 'tool'].every((k) => kinds.has(k)) && orphans.length === 0 && leftover.length === 0 && contentOk && specIssues.length === 0 && oneSession && extraOk
  console.log(ok ? 'CLS VERIFY PASS' : 'CLS VERIFY FAIL')
  return ok
}

export const outboxOf = (home: string) => path.join(home, 'agentobs', 'outbox')
