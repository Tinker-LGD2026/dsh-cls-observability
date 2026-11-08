/**
 * Contract tests: replay every recorded DSH 0.2.x session fixture and check
 * structural invariants of the produced AgentObs span trees.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSessionLog, replaySession, replaySessionGroup } from '../src/replay.ts'
import { fromRecord, validateSpans } from '../src/spec-check.ts'
import type { SpanRecord } from '../src/otlp/types.ts'
import { fromSpan, renderTree as renderNodes } from '../src/tree.ts'

// Session recordings from a DeepSeek Harness checkout (DSH_REPO, default a sibling directory); skipped when absent.
const SNAPSHOTS = path.resolve(process.env.DSH_REPO ?? path.join(import.meta.dirname, '../../deepseek-harness'), 'snapshots')
const options = { captureContent: false, maxContentChars: 4000, commonAttributes: { 'gen_ai.agent.type': 'deepseek-harness' } }

function findLogs(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...findLogs(full))
    else if (/^session(\.\d+)?\.v4\.jsonl$/.test(entry)) out.push(full)
  }
  return out.sort()
}

const logs = findLogs(SNAPSHOTS)
const kindOf = (s: SpanRecord) => String(s.attributes['gen_ai.span.kind'])
const rel = (f: string) => path.relative(SNAPSHOTS, f)

const renderTree = (spans: SpanRecord[]) => renderNodes(spans.map(fromSpan))

describe.skipIf(logs.length === 0)('DSH session fixtures', () => {
  it('found the recorded fixtures', () => {
    expect(logs.length).toBeGreaterThan(100)
  })

  for (const file of logs) {
    it(`builds a well-formed span tree: ${rel(file)}`, () => {
      const log = readSessionLog(file)
      const spans = replaySession(log, options)
      const again = replaySession(readSessionLog(file), options)
      expect(again.map((s) => s.spanId)).toEqual(spans.map((s) => s.spanId)) // deterministic ids

      const ids = new Set<string>()
      for (const s of spans) {
        expect(s.traceId).toMatch(/^[0-9a-f]{32}$/)
        expect(s.spanId).toMatch(/^[0-9a-f]{16}$/)
        expect(ids.has(s.spanId), `duplicate span ${s.name}`).toBe(false)
        ids.add(s.spanId)
        expect(s.endNs >= s.startNs).toBe(true)
        expect(['entry', 'agent', 'step', 'chat', 'tool']).toContain(kindOf(s))
        // A subagent reports its task's session (here its parent: replayed alone); agent.id is its own session.
        expect(s.attributes['gen_ai.session.id']).toBe(log.header.origin === 'subagent' && log.header.parentSession ? log.header.parentSession : log.header.id)
        expect(s.attributes['gen_ai.agent.id']).toBe(log.header.id)
        const fr = s.attributes['gen_ai.response.finish_reasons']
        if (fr !== undefined) expect(Array.isArray(fr)).toBe(true)
        // content capture is off: no message bodies leak
        expect(s.attributes['gen_ai.input.messages']).toBeUndefined()
        expect(s.attributes['gen_ai.tool.call.arguments']).toBeUndefined()
      }

      // every non-entry span's parent exists in the same trace
      const byId = new Map(spans.map((s) => [s.spanId, s]))
      for (const s of spans) {
        if (kindOf(s) === 'entry') continue
        const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined
        // A turn still open at end of log (crash/cancel recording) has no agent/entry yet.
        if (!parent) continue
        expect(parent.traceId).toBe(s.traceId)
      }

      // one entry per ended live turn
      const live = log.events.filter((e) => e.seq >= log.inheritedEventCount)
      const startedTurns = new Set(live.filter((e) => e.type === 'turn/start').map((e) => e.data.turn))
      const endedTurns = live.filter((e) => e.type === 'turn/end' && startedTurns.has(e.data.turn) && e.data.reason?.kind !== 'forked')
      expect(spans.filter((s) => kindOf(s) === 'entry').length).toBe(endedTurns.length)

      // one chat span per durable settlement inside a live turn
      const settlements = live.filter((e) => (e.type === 'assistant/message' || e.type === 'assistant/attempt') && startedTurns.has(e.data.turn))
      expect(spans.filter((s) => kindOf(s) === 'chat').length).toBe(settlements.length)

      // tool spans = settled native calls + settled PTC sub-dispatches
      const calls = new Set(live.filter((e) => e.type === 'tool/call' && startedTurns.has(e.data.turn)).map((e) => e.data.callId))
      const nativeResults = live.filter((e) => e.type === 'tool/result' && calls.has(e.data.message?.source?.callId ?? e.data.message?.toolCallId)).length
      const ptcResults = live.filter((e) => e.type === 'tool/ptc-dispatch' && calls.has(e.data.rootCallId)).length
      expect(spans.filter((s) => kindOf(s) === 'tool').length).toBe(nativeResults + ptcResults)
    })
  }
})

describe.skipIf(logs.length === 0)('CLS spec naming and content (capture on)', () => {
  const on = { ...options, captureContent: true }
  it('names spans per spec and fills turn I/O and tool arguments/results', () => {
    let entries = 0, entriesWithInput = 0, entriesWithOutput = 0, tools = 0, subagentAgents = 0
    for (const file of logs) {
      const log = readSessionLog(file)
      const spans = replaySession(log, on)
      const byId = new Map(spans.map((s) => [s.spanId, s]))
      for (const s of spans) {
        const a = s.attributes
        switch (kindOf(s)) {
          case 'step':
            expect(s.name).toBe(`react round_${String(a['gen_ai.react.round'])}`)
            expect(a['gen_ai.operation.name']).toBe('react')
            break
          case 'entry': {
            expect(s.name).toBe('enter_application')
            entries++
            const agent = spans.find((x) => x.parentSpanId === s.spanId)
            if (a['gen_ai.input.messages']) entriesWithInput++
            if (a['gen_ai.output.messages']) {
              entriesWithOutput++
              const out = a['gen_ai.output.messages'] as { role: string; parts: { type: string }[] }[]
              expect(out[0]!.role).toBe('assistant')
              expect(out[0]!.parts.some((p) => p.type === 'reasoning') && out[0]!.parts.some((p) => p.type !== 'reasoning')).toBe(false)
            }
            expect(agent?.attributes['gen_ai.output.messages']).toEqual(a['gen_ai.output.messages'])
            break
          }
          case 'agent':
            if (log.header.origin === 'subagent') {
              subagentAgents++
              expect(a['gen_ai.operation.name']).toBe('invoke_subagent')
              expect(s.name.startsWith('invoke_agent ')).toBe(true)
            } else {
              expect(a['gen_ai.operation.name']).toBe('invoke_agent')
            }
            break
          case 'tool':
            tools++
            expect(a['gen_ai.tool.call.arguments'], `${rel(file)} ${s.name}`).toBeDefined()
            expect(typeof a['gen_ai.tool.call.result']).toBe('string')
            break
        }
        if (kindOf(s) !== 'entry' && s.parentSpanId && byId.has(s.parentSpanId)) expect(byId.get(s.parentSpanId)!.traceId).toBe(s.traceId)
      }
    }
    // Every turn that took at least one user/trigger message and produced an answer carries both.
    expect(entriesWithInput / entries).toBeGreaterThan(0.95)
    expect(entriesWithOutput / entries).toBeGreaterThan(0.9)
    expect(tools).toBeGreaterThan(400)
    expect(subagentAgents).toBeGreaterThan(0)
  })
})

describe.skipIf(logs.length === 0)('chat input deltas and subagent names (grouped replay)', () => {
  const on = { ...options, captureContent: true }
  const groups = new Map<string, string[]>()
  for (const f of logs) groups.set(path.dirname(f), [...(groups.get(path.dirname(f)) ?? []), f])

  it('every chat carries a full report or a delta that rebuilds the whole context', () => {
    const resets = new Map<string, number>()
    let chats = 0, deltas = 0
    for (const files of groups.values()) {
      const sessionLogs = files.map(readSessionLog)
      replaySessionGroup(sessionLogs, on).forEach((spans) => {
        let rebuilt: unknown[] | undefined
        const mainChats = spans.filter((s) => kindOf(s) === 'chat' && !s.attributes['agent.custom.llm_purpose'])
        mainChats.sort((a, b) => (a.endNs < b.endNs ? -1 : a.endNs > b.endNs ? 1 : 0))
        for (const c of mainChats) {
          chats++
          const a = c.attributes
          const full = a['gen_ai.input.messages'] as unknown[] | undefined
          const delta = a['gen_ai.input.messages_delta'] as unknown[] | undefined
          expect(full === undefined, 'exactly one of messages / messages_delta').not.toBe(delta === undefined)
          expect(a['gen_ai.input.messages.hash']).toMatch(/^[0-9a-f]{32}$/)
          if (full) {
            rebuilt = [...full]
            const reason = String(a['agent.custom.input_delta_reset'] ?? 'first_report')
            resets.set(reason, (resets.get(reason) ?? 0) + 1)
          } else {
            deltas++
            expect(rebuilt, 'a delta needs an earlier full report').toBeDefined()
            rebuilt!.push(...delta!)
          }
          if (a['agent.custom.input_messages_omitted'] === undefined) {
            expect(rebuilt!.length).toBe(a['agent.custom.input_message_count'])
          }
        }
      })
    }
    expect(deltas).toBeGreaterThan(chats / 3)
    // One full report per session; compaction rewrites the prefix and forces another.
    expect(resets.get('first_report')).toBeGreaterThan(0)
    expect(resets.has('prefix_changed') || resets.has('context_shrank')).toBe(true)
  })

  it('names subagents by their catalog name', () => {
    let named = 0
    for (const files of groups.values()) {
      const sessionLogs = files.map(readSessionLog)
      const results = replaySessionGroup(sessionLogs, on)
      sessionLogs.forEach((log, i) => {
        if (log.header.origin !== 'subagent') return
        const parent = sessionLogs.find((l) => l.header.id === log.header.parentSession)
        const catalog = parent?.events.find((e) => e.type === 'subagent/catalog' && e.data.childId === log.header.id)
        for (const s of results[i]!.filter((x) => kindOf(x) === 'agent')) {
          if (!catalog) continue
          named++
          expect(s.attributes['gen_ai.agent.name']).toBe(catalog.data.name)
          expect(s.name).toBe(`invoke_agent ${String(catalog.data.name)}`)
        }
        // Every span of the subagent belongs to the task that spawned it.
        const roots = sessionLogs.filter((l) => l.header.origin !== 'subagent').map((l) => l.header.id)
        for (const s of results[i]!) {
          if (!parent) continue
          const sid = String(s.attributes['gen_ai.session.id'])
          expect(roots.includes(sid) || sid === log.header.parentSession).toBe(true)
          expect(String(s.attributes['gen_ai.turn.id'])).toMatch(new RegExp(`^${sid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:[A-Za-z0-9_-]+:t\\d+$`))
        }
      })
    }
    expect(named).toBeGreaterThan(5)
  })
})

describe.skipIf(logs.length === 0)('CLS AgentObs spec validation of every recording', () => {
  const groups = new Map<string, string[]>()
  for (const f of logs) groups.set(path.dirname(f), [...(groups.get(path.dirname(f)) ?? []), f])
  for (const content of [false, true]) {
    it(`has no spec violations (content ${content ? 'on' : 'off'})`, () => {
      const issues: string[] = []
      for (const files of groups.values()) {
        const spans = replaySessionGroup(files.map(readSessionLog), { ...options, captureContent: content }).flat()
        for (const i of validateSpans(spans.map(fromRecord), { content, complete: true })) issues.push(`${rel(files[0]!)}: ${i.span}: ${i.problem}`)
      }
      expect(issues.slice(0, 20)).toEqual([])
    })
  }
})

const pick = (name: string) => logs.find((f) => rel(f) === name)

describe.skipIf(logs.length === 0)('span tree snapshots', () => {
  for (const name of [
    'sdk/bash-tool/session.v4.jsonl',
    'sdk/ptc-turn/session.v4.jsonl',
    'sdk/max-tokens-continue/session.v4.jsonl',
    'acp/cancel-tool-calls/session.v4.jsonl',
    'acp/escalation-approved/session.v4.jsonl',
    'sdk/manual-compact/session.v4.jsonl',
  ]) {
    const file = pick(name)
    it.skipIf(!file)(name, () => {
      expect(renderTree(replaySession(readSessionLog(file!), options))).toMatchSnapshot()
    })
  }
})
