/**
 * Live-path tests with a fake Cordis context: chat timing from assistant-stream
 * frames, exact tool durations, subagent parent adoption via AsyncLocalStorage,
 * auxiliary calls, and host isolation (collector failures never throw).
 */
import { describe, expect, it } from 'vitest'
import { Collector } from '../src/collector.ts'
import { BUILTIN_RULES, Redactor } from '../src/redact.ts'
import type { SessionEvent, SessionLike } from '../src/dsh-types.ts'
import type { SpanRecord } from '../src/otlp/types.ts'

class FakeContext {
  listeners = new Map<string, ((...args: any[]) => any)[]>()
  on(event: string, listener: (...args: any[]) => any) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }
  emit(event: string, ...args: any[]) {
    for (const l of this.listeners.get(event) ?? []) l(...args)
  }
  waterfall<T>(event: string, arg: unknown, final: () => T): T {
    const ls = this.listeners.get(event) ?? []
    const run = (i: number): T => (i < ls.length ? ls[i]!(arg, () => run(i + 1)) : final())
    return run(0)
  }
}

function session(id: string, header: Partial<SessionLike['header']> = {}, lifecycle = 0): SessionLike {
  return { id, header: { id, createdAt: 0, isSeeded: false, ...header }, inheritedEventCount: 0, firstLiveSeq: lifecycle, firstLifecycleSeq: lifecycle }
}

function setup() {
  const ctx = new FakeContext()
  const spans: SpanRecord[] = []
  const warnings: string[] = []
  new Collector({
    builder: { captureContent: false, maxContentChars: 1000, commonAttributes: {} },
    includeAuxiliary: true,
    sampleRatio: 1,
    emit: (s) => spans.push(s),
    log: (_l, m) => warnings.push(m),
  }).attach(ctx)
  let seq = 0
  const ev = (s: SessionLike, type: string, data: any, time = Date.now()): void =>
    ctx.emit('session/event', s, { type, seq: seq++, time, data } as SessionEvent)
  return { ctx, spans, warnings, ev }
}

const kind = (s: SpanRecord) => s.attributes['gen_ai.span.kind']

describe('Collector (live)', () => {
  it('times chats from assistant-stream frames and tools from tools/execute', async () => {
    const { ctx, spans, ev } = setup()
    const s = session('S1')
    ctx.emit('session/created', s)
    const t0 = Date.now()
    ev(s, 'turn/start', { turn: 1 }, t0)
    ev(s, 'step/start', { turn: 1, step: 1 }, t0 + 1)
    ev(s, 'user/message', { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, t0 + 2)
    ev(s, 'request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash', temperature: 1 } }, reason: 'initial' }, t0 + 3)
    const agent = { session: s }
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'S1:1', revision: 1, turn: 1, step: 1 } })
    const first = Date.now() + 120
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'S1:1', revision: 2, index: 0, time: first, chunk: { type: 'text-delta', index: 0, text: 'x' } } })
    ev(s, 'assistant/message', {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }], source: { kind: 'model' } },
      stream: [{ type: 'chunk', time: first, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }],
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 90 },
    }, first + 10)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'S1:1', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 4 } } })
    ev(s, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' })
    await ctx.waterfall('tools/execute', { callId: 'c1', rootCallId: 'c1', name: 'read', agent }, async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { content: [] }
    })
    ev(s, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'c1' } } })
    ev(s, 'step/end', { turn: 1, step: 1 })
    ev(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } })

    const chat = spans.find((x) => kind(x) === 'chat')!
    expect(chat.attributes['gen_ai.response.time_to_first_token_ms']).toBeGreaterThanOrEqual(100)
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(100)
    expect(chat.attributes['gen_ai.usage.cache_miss.input_tokens']).toBe(10)
    expect(chat.attributes['gen_ai.provider.name']).toBe('deepseek')
    expect(chat.attributes['gen_ai.response.finish_reasons']).toEqual(['tool_calls'])
    const tool = spans.find((x) => kind(x) === 'tool')!
    expect(tool.attributes['agent.custom.duration_source']).toBe('execute')
    expect(tool.attributes['gen_ai.tool.call.duration_ms']).toBeGreaterThanOrEqual(25)
    expect(spans.map(kind)).toEqual(['chat', 'tool', 'step', 'agent', 'entry'])
    expect(new Set(spans.map((x) => x.traceId)).size).toBe(1)
  })

  it('attaches a freshly created subagent to the spawning tool span, but not a resumed one', async () => {
    const { ctx, spans, ev } = setup()
    const parent = session('P')
    ctx.emit('session/created', parent)
    ev(parent, 'turn/start', { turn: 1 })
    ev(parent, 'step/start', { turn: 1, step: 1 })
    ev(parent, 'tool/call', { turn: 1, step: 1, callId: 'sub1', name: 'subagent', arguments: '{}' })
    const child = session('C', { parentSession: 'P', origin: 'subagent' })
    const resumed = session('R', { parentSession: 'P', origin: 'subagent' }, 42)
    await ctx.waterfall('tools/execute', { callId: 'sub1', rootCallId: 'sub1', name: 'subagent', agent: { session: parent } }, async () => {
      ctx.emit('session/created', child)
      ctx.emit('session/created', resumed)
      return {}
    })
    ev(child, 'turn/start', { turn: 1 })
    ev(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    ev(resumed, 'turn/start', { turn: 5 })
    ev(resumed, 'turn/end', { turn: 5, reason: { kind: 'completed' } })
    ev(parent, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'sub1', content: [], source: { kind: 'tool', callId: 'sub1' } } })

    const parentTool = spans.find((x) => kind(x) === 'tool')!
    // Nested in the parent's trace: no entry, the agent span hangs off the tool span.
    expect(spans.some((x) => kind(x) === 'entry' && x.attributes['gen_ai.agent.id'] === 'C')).toBe(false)
    const childAgent = spans.find((x) => kind(x) === 'agent' && x.attributes['gen_ai.agent.id'] === 'C')!
    expect(childAgent.traceId).toBe(parentTool.traceId)
    expect(childAgent.parentSpanId).toBe(parentTool.spanId)
    expect(childAgent.attributes['gen_ai.agent.scope']).toBe('subagent')
    expect(childAgent.attributes['gen_ai.subagent.parent_tool_call.id']).toBe('sub1')
    const resumedEntry = spans.find((x) => kind(x) === 'entry' && x.attributes['gen_ai.agent.id'] === 'R')!
    expect(resumedEntry.parentSpanId).toBeUndefined()
    expect(resumedEntry.attributes['gen_ai.subagent.parent_tool_call.id']).toBeUndefined()
  })

  it('records auxiliary llm calls under the open turn and passes chunks through unchanged', async () => {
    const { ctx, spans, ev } = setup()
    const s = session('A')
    ctx.emit('session/created', s)
    ev(s, 'turn/start', { turn: 1 })
    const chunks = [{ type: 'text-delta', index: 0, text: 'sum' }, { type: 'usage', usage: { inputTokens: 7, outputTokens: 3 } }, { type: 'finish', reason: { kind: 'stop' } }]
    const stream = ctx.waterfall('llm/stream', { provider: 'deepseek', model: 'm', sessionId: 'A', purpose: 'compaction' }, () => (async function* () { yield* chunks })()) as AsyncIterable<unknown>
    const seen: unknown[] = []
    for await (const c of stream) seen.push(c)
    expect(seen).toEqual(chunks)
    ev(s, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    const aux = spans.find((x) => x.attributes['agent.custom.llm_purpose'] === 'compaction')!
    expect(aux.attributes['gen_ai.usage.output_tokens']).toBe(3)
    const agent = spans.find((x) => kind(x) === 'agent')!
    expect(aux.parentSpanId).toBe(agent.spanId)
    expect(aux.attributes['agent.custom.replayable']).toBe(false)
  })

  it('never throws into the host on malformed input', () => {
    const { ctx, warnings } = setup()
    expect(() => ctx.emit('session/event', null, null)).not.toThrow()
    expect(() => ctx.emit('session/created', { id: 'x' })).not.toThrow()
    expect(() => ctx.emit('agent/assistant-stream', {})).not.toThrow()
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('Collector: content redaction', () => {
  it('masks secrets in tool arguments, tool results and chat input before export', () => {
    const ctx = new FakeContext()
    const spans: SpanRecord[] = []
    new Collector({
      builder: { captureContent: true, maxContentChars: 1000, commonAttributes: {}, redactor: new Redactor(BUILTIN_RULES) },
      includeAuxiliary: true,
      sampleRatio: 1,
      emit: (s) => spans.push(s),
      log: () => {},
    }).attach(ctx)
    const id = 'AKID' + 'x1Y2z3'.repeat(6)
    const s = session('RD')
    let seq = 0
    const ev = (type: string, data: any, surfaceOp?: 'append') =>
      ctx.emit('session/event', s, { type, seq: seq++, time: Date.now(), data, ...(surfaceOp ? { surfaceOp } : {}) } as SessionEvent)
    ctx.emit('session/created', s)
    ev('turn/start', { turn: 1 })
    ev('step/start', { turn: 1, step: 1 })
    ev('user/message', { role: 'user', content: [{ type: 'text', text: `use secret_key=${'q'.repeat(20)}` }], source: { kind: 'user' } }, 'append')
    ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }], source: { kind: 'model' } }, stream: [] }, 'append')
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'env', password: 'pw' }) })
    ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: `TENCENTCLOUD_SECRET_ID=${id}` }], source: { kind: 'tool', callId: 'c1' } } }, 'append')
    const tool = spans.find((x) => kind(x) === 'tool')!.attributes
    expect(tool['gen_ai.tool.call.arguments']).toEqual({ command: 'env', password: '[REDACTED:key]' })
    expect(String(tool['gen_ai.tool.call.result'])).not.toContain(id)
    expect(tool['agent.custom.redacted_types']).toEqual(['key', 'tencentcloud_secret_id'])
    const chat = spans.find((x) => kind(x) === 'chat')!.attributes
    expect(JSON.stringify(chat['gen_ai.input.messages'])).toContain('secret_key=[REDACTED:assignment]')
    expect(chat['agent.custom.content_redacted']).toBe(true)
  })
})

describe('Collector: closing a turn left open by a crash', () => {
  const closedTurns = () => { const keys = new Set<string>(); return { has: (k: string) => keys.has(k), add: (k: string) => { keys.add(k) } } }
  function setupWith(closed: ReturnType<typeof closedTurns>) {
    const ctx = new FakeContext()
    const spans: SpanRecord[] = []
    new Collector({
      builder: { captureContent: false, maxContentChars: 1000, commonAttributes: {} },
      includeAuxiliary: true, sampleRatio: 1, emit: (s) => spans.push(s), log: () => {}, closedTurns: closed,
    }).attach(ctx)
    return { ctx, spans }
  }
  const msg = (role: string, content: unknown[], extra: object = {}) => ({ role, content, source: { kind: role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'model' }, ...extra })
  /** Turn 1 completed; turn 2 crashed with `bash` call c2 running; DSH appended closers on resume. */
  function crashedLog(): SessionEvent[] {
    const e: [string, unknown, number?][] = [
      ['turn/start', { turn: 1 }], ['step/start', { turn: 1, step: 1 }],
      ['user/message', msg('user', [{ type: 'text', text: 'q1' }])],
      ['assistant/message', { turn: 1, step: 1, message: msg('assistant', [{ type: 'text', text: 'a1' }]), stream: [] }],
      ['step/end', { turn: 1, step: 1 }], ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
      ['turn/start', { turn: 2 }], ['step/start', { turn: 2, step: 1 }],
      ['user/message', msg('user', [{ type: 'text', text: 'q2' }])],
      ['assistant/message', { turn: 2, step: 1, message: msg('assistant', [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }]), stream: [] }],
      ['tool/call', { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }, 1000],
      // DSH closers: same time as the last real event.
      ['tool/result', { turn: 2, step: 1, message: msg('tool', [{ type: 'text', text: 'interrupted' }], { id: 'interrupted-tool-result-c2-11', toolCallId: 'c2', isError: true, source: { kind: 'tool', callId: 'c2' } }), error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } }, 1000],
      ['step/end', { turn: 2, step: 1 }, 1000],
      ['turn/end', { turn: 2, reason: { kind: 'interrupted' } }, 1000],
    ]
    return e.map(([type, data, time], seq) => ({ type, seq, time: time ?? 100 + seq, data, ...(type.endsWith('message') || type === 'tool/result' ? { surfaceOp: 'append' } : {}) }) as SessionEvent)
  }
  const restored = (id: string, log: SessionEvent[]) => ({ ...session(id, {}, log.length), snapshotEvents: () => log }) as SessionLike

  it('emits the root, the interrupted step and the unanswered tool call — nothing finished before the crash', () => {
    const { ctx, spans } = setupWith(closedTurns())
    ctx.emit('session/created', restored('K1', crashedLog()))
    expect(spans.map((x) => `${kind(x)}:${String(x.attributes['gen_ai.turn.id'])}`).sort()).toEqual(['agent:K1:t2', 'entry:K1:t2', 'step:K1:t2', 'tool:K1:t2'])
    expect(spans.every((x) => x.attributes['agent.custom.closed_after_crash'] === true)).toBe(true)
    const entry = spans.find((x) => kind(x) === 'entry')!
    expect(entry.status?.code).toBe(2)
    expect(spans.find((x) => kind(x) === 'tool')!.status?.code).toBe(2)
    expect(new Set(spans.map((x) => x.traceId)).size).toBe(1)
  })

  it('finds the closers when DSH appends a seed marker after them on resume (0.2.2-rc.1)', () => {
    const log = crashedLog()
    log.push({ type: 'session/end-seed', seq: log.length, time: 5000, data: {} } as SessionEvent)
    const { ctx, spans } = setupWith(closedTurns())
    ctx.emit('session/created', restored('K4', log))
    expect(spans.map(kind).sort()).toEqual(['agent', 'entry', 'step', 'tool'])
  })

  it('does not emit a step that had completed before the crash', () => {
    const log = crashedLog().slice(0, 9)
    log.push(
      { type: 'assistant/message', seq: 9, time: 200, data: { turn: 2, step: 1, message: msg('assistant', [{ type: 'text', text: 'a2' }]), stream: [] }, surfaceOp: 'append' } as SessionEvent,
      { type: 'step/end', seq: 10, time: 210, data: { turn: 2, step: 1 } } as SessionEvent,
      { type: 'turn/end', seq: 11, time: 210, data: { turn: 2, reason: { kind: 'interrupted' } } } as SessionEvent,
    )
    const { ctx, spans } = setupWith(closedTurns())
    ctx.emit('session/created', restored('K2', log))
    expect(spans.map(kind).sort()).toEqual(['agent', 'entry'])
  })

  it('skips spans the dead process already emitted for events the log never got', () => {
    // First: what a closure would emit with no knowledge of the dead process.
    const probe = setupWith(closedTurns())
    probe.ctx.emit('session/created', restored('K5', crashedLog()))
    const stepAndTool = probe.spans.filter((x) => kind(x) === 'step' || kind(x) === 'tool').map((x) => x.spanId)
    expect(stepAndTool).toHaveLength(2)
    // The dead process had emitted those two (DSH dispatched tool/result and step/end before persisting them).
    const ctx = new FakeContext()
    const spans: SpanRecord[] = []
    new Collector({
      builder: { captureContent: false, maxContentChars: 1000, commonAttributes: {} },
      includeAuxiliary: true, sampleRatio: 1, emit: (x) => spans.push(x), log: () => {}, closedTurns: closedTurns(),
      emittedSpans: { lookup: (key) => ({ spanIds: new Set(key === 'K5:t2' ? stepAndTool : []), ended: false }) },
    }).attach(ctx)
    ctx.emit('session/created', restored('K5', crashedLog()))
    expect(spans.map(kind).sort()).toEqual(['agent', 'entry'])
  })

  it('closes nothing when the dead process saw the turn end', () => {
    const ctx = new FakeContext()
    const spans: SpanRecord[] = []
    const closed = closedTurns()
    new Collector({
      builder: { captureContent: false, maxContentChars: 1000, commonAttributes: {} },
      includeAuxiliary: true, sampleRatio: 1, emit: (x) => spans.push(x), log: () => {}, closedTurns: closed,
      emittedSpans: { lookup: () => ({ spanIds: new Set(), ended: true }) },
    }).attach(ctx)
    ctx.emit('session/created', restored('K6', crashedLog()))
    expect(spans).toEqual([])
    expect(closed.has('K6:t2')).toBe(true)
  })

  it('closes a crashed turn once, however often the session is reopened', () => {
    const closed = closedTurns()
    const first = setupWith(closed)
    first.ctx.emit('session/created', restored('K3', crashedLog()))
    const again = setupWith(closed)
    again.ctx.emit('session/created', restored('K3', crashedLog()))
    expect(first.spans.length).toBe(4)
    expect(again.spans).toEqual([])
  })
})

describe('Collector: chat input deltas, restored history, subagent names', () => {
  function liveSetup(captureContent = true) {
    const ctx = new FakeContext()
    const spans: SpanRecord[] = []
    new Collector({
      builder: { captureContent, maxContentChars: 1000, commonAttributes: {}, ...(captureContent ? { redactor: new Redactor(BUILTIN_RULES) } : {}) },
      includeAuxiliary: true,
      sampleRatio: 1,
      emit: (s) => spans.push(s),
      log: () => {},
    }).attach(ctx)
    return { ctx, spans }
  }
  const text = (role: string, t: string, source = { kind: role === 'user' ? 'user' : 'model' }) => ({ role, content: [{ type: 'text', text: t }], source })
  /** A session whose log can be appended to and read back like a real one. */
  function liveSession(id: string, header: Partial<SessionLike['header']> = {}, history: SessionEvent[] = []) {
    const log: SessionEvent[] = [...history]
    const s = { ...session(id, header, history.length), snapshotEvents: () => [...log] } as SessionLike & { snapshotEvents: () => SessionEvent[] }
    const append = (ctx: FakeContext, type: string, data: any, surfaceOp?: 'append') => {
      const event = { type, seq: log.length, time: Date.now(), data, ...(surfaceOp ? { surfaceOp } : {}) } as SessionEvent
      log.push(event)
      ctx.emit('session/event', s, event)
    }
    return { s, log, append }
  }
  function turn(ctx: FakeContext, append: ReturnType<typeof liveSession>['append'], n: number, prompt: string, answer: string) {
    append(ctx, 'turn/start', { turn: n })
    append(ctx, 'step/start', { turn: n, step: 1 })
    append(ctx, 'user/message', text('user', prompt), 'append')
    append(ctx, 'assistant/message', { turn: n, step: 1, message: text('assistant', answer), stream: [] }, 'append')
    append(ctx, 'step/end', { turn: n, step: 1 })
    append(ctx, 'turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  const chats = (spans: SpanRecord[]) => spans.filter((x) => kind(x) === 'chat')

  it('reports the full context once per session, then only what each request added', () => {
    const { ctx, spans } = liveSetup()
    const { s, append } = liveSession('D')
    ctx.emit('session/created', s)
    append(ctx, 'system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'SYS' }], source: { kind: 'system-prompt' } } }, 'append')
    turn(ctx, append, 1, 'q1', 'a1')
    turn(ctx, append, 2, 'q2', 'a2')
    const [c1, c2] = chats(spans)
    expect(c1!.attributes['gen_ai.input.messages']).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'q1' }] }])
    expect(c1!.attributes['gen_ai.system_instructions']).toBe('SYS')
    expect(c2!.attributes['gen_ai.input.messages']).toBeUndefined()
    expect(c2!.attributes['gen_ai.input.messages_delta']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'a1' }] },
      { role: 'user', parts: [{ type: 'text', content: 'q2' }] },
    ])
    expect(c2!.attributes['agent.custom.input_message_count']).toBe(3)
  })

  it('seeds a restored session from its stored log, so the first live chat carries the whole context', () => {
    const { ctx, spans } = liveSetup()
    const restored = [
      { type: 'user/message', seq: 0, time: 1, data: text('user', 'old question'), surfaceOp: 'append' },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: text('assistant', 'old answer'), stream: [] }, surfaceOp: 'append' },
    ] as SessionEvent[]
    const { s, append } = liveSession('R2', {}, restored)
    ctx.emit('session/created', s)
    turn(ctx, append, 2, 'new question', 'new answer')
    const input = chats(spans)[0]!.attributes['gen_ai.input.messages'] as { parts: { content: string }[] }[]
    expect(input.map((m) => m.parts[0]!.content)).toEqual(['old question', 'old answer', 'new question'])
  })

  it('does not double-count the event that first introduces a session mid-run', () => {
    const { ctx, spans } = liveSetup()
    const { s, append } = liveSession('M')
    // No session/created: the plugin attached after the session existed.
    turn(ctx, append, 1, 'q', 'a')
    expect((chats(spans)[0]!.attributes['gen_ai.input.messages'] as unknown[]).length).toBe(1)
  })

  it('keeps model-written text out of names and events when content capture is off', async () => {
    const { ctx, spans } = liveSetup(false)
    const parent = liveSession('P8')
    ctx.emit('session/created', parent.s)
    parent.append(ctx, 'turn/start', { turn: 1 })
    parent.append(ctx, 'goal/change', { goal: 'ship the secret project by friday', status: 'active' })
    parent.append(ctx, 'step/start', { turn: 1, step: 1 })
    parent.append(ctx, 'tool/call', { turn: 1, step: 1, callId: 'c8', name: 'subagent', arguments: '{}' })
    const child = liveSession('c8c8c8c8-0000-4000-8000-00000000c8c8', { parentSession: 'P8', origin: 'subagent' })
    await ctx.waterfall('tools/execute', { callId: 'c8', rootCallId: 'c8', name: 'subagent', agent: { session: parent.s } }, async () => {
      parent.append(ctx, 'subagent/catalog', { version: 0, childId: child.s.id, childCreatedAt: 0, mode: 'continuable', label: 'Review the acquisition memo' })
      ctx.emit('session/created', child.s)
      return {}
    })
    turn(ctx, child.append, 1, 'go', 'done')
    parent.append(ctx, 'step/end', { turn: 1, step: 1 })
    parent.append(ctx, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    const agent = spans.find((x) => kind(x) === 'agent' && x.attributes['gen_ai.agent.id'] === child.s.id)!
    expect(agent.name).toBe('invoke_agent subagent')
    expect(agent.attributes['agent.custom.subagent_label']).toBeUndefined()
    const goal = spans.flatMap((x) => x.events ?? []).find((e) => e.name === 'goal/change')!
    expect(goal.attributes).toEqual({ status: 'active' })
    expect(JSON.stringify(spans, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/acquisition|secret project/)
  })

  it('names a subagent by its creation label when the catalog has no name (DSH 0.2.2-rc.1)', async () => {
    const { ctx, spans } = liveSetup()
    const parent = liveSession('P9')
    ctx.emit('session/created', parent.s)
    parent.append(ctx, 'turn/start', { turn: 1 })
    parent.append(ctx, 'step/start', { turn: 1, step: 1 })
    parent.append(ctx, 'tool/call', { turn: 1, step: 1, callId: 'c9', name: 'subagent', arguments: '{}' })
    const child = liveSession('c6b59b4a-589c-4e39-8e7c-4b642ddf7a15', { parentSession: 'P9', origin: 'subagent' })
    await ctx.waterfall('tools/execute', { callId: 'c9', rootCallId: 'c9', name: 'subagent', agent: { session: parent.s } }, async () => {
      parent.append(ctx, 'subagent/catalog', { version: 0, childId: child.s.id, childCreatedAt: 0, mode: 'continuable', label: 'Reply subagent-ok' })
      ctx.emit('session/created', child.s)
      return {}
    })
    turn(ctx, child.append, 1, 'go', 'done')
    const agent = spans.find((x) => kind(x) === 'agent' && x.attributes['gen_ai.agent.id'] === child.s.id)!
    expect(agent.attributes['gen_ai.agent.name']).toBe('Reply subagent-ok')
    expect(agent.name).toBe('invoke_agent Reply subagent-ok')
    expect(agent.attributes['agent.custom.subagent_label']).toBe('Reply subagent-ok')
    expect(agent.attributes['gen_ai.turn.id']).toBe('P9:4b642ddf7a15:t1')
  })

  it('names a subagent by the name its parent reserved in subagent/catalog', async () => {
    const { ctx, spans } = liveSetup()
    const parent = liveSession('P2')
    ctx.emit('session/created', parent.s)
    parent.append(ctx, 'turn/start', { turn: 1 })
    parent.append(ctx, 'step/start', { turn: 1, step: 1 })
    parent.append(ctx, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'subagent', arguments: '{}' })
    const child = liveSession('C2', { parentSession: 'P2', origin: 'subagent' })
    await ctx.waterfall('tools/execute', { callId: 'c1', rootCallId: 'c1', name: 'subagent', agent: { session: parent.s } }, async () => {
      parent.append(ctx, 'subagent/catalog', { version: 3, childId: 'C2', childCreatedAt: 0, mode: 'continuable', label: 'x', name: 'researcher' })
      ctx.emit('session/created', child.s)
      return {}
    })
    turn(ctx, child.append, 1, 'go', 'done')
    const agent = spans.find((x) => kind(x) === 'agent' && x.attributes['gen_ai.agent.id'] === 'C2')!
    expect(agent.name).toBe('invoke_agent researcher')
    // Part of the parent's task: same session id, own turn segment, own DSH session kept.
    expect(agent.attributes['gen_ai.session.id']).toBe('P2')
    expect(agent.attributes['gen_ai.turn.id']).toBe('P2:C2:t1')
    expect(agent.attributes['agent.custom.dsh_session_id']).toBe('C2')
    expect(agent.attributes['gen_ai.agent.name']).toBe('researcher')
    expect(agent.attributes['gen_ai.operation.name']).toBe('invoke_subagent')
    expect(chats(spans).find((x) => x.attributes['gen_ai.agent.id'] === 'C2')!.attributes['gen_ai.agent.name']).toBe('researcher')
  })

  it('keeps an entry root for a later subagent turn in its own trace', async () => {
    const { ctx, spans } = liveSetup()
    const parent = liveSession('P3')
    ctx.emit('session/created', parent.s)
    parent.append(ctx, 'turn/start', { turn: 1 })
    parent.append(ctx, 'step/start', { turn: 1, step: 1 })
    parent.append(ctx, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'subagent', arguments: '{}' })
    const child = liveSession('C3', { parentSession: 'P3', origin: 'subagent' })
    await ctx.waterfall('tools/execute', { callId: 'c1', rootCallId: 'c1', name: 'subagent', agent: { session: parent.s } }, async () => {
      ctx.emit('session/created', child.s)
      return {}
    })
    turn(ctx, child.append, 1, 'first', 'a1')
    turn(ctx, child.append, 2, 'second', 'a2')
    const mine = spans.filter((x) => x.attributes['gen_ai.agent.id'] === 'C3')
    expect(mine.filter((x) => kind(x) === 'entry').map((x) => x.attributes['gen_ai.turn.id'])).toEqual(['P3:C3:t2'])
    const entry = mine.find((x) => kind(x) === 'entry')!
    expect(entry.parentSpanId).toBeUndefined()
    expect(mine.find((x) => kind(x) === 'agent' && x.attributes['gen_ai.turn.id'] === 'P3:C3:t2')!.parentSpanId).toBe(entry.spanId)
  })

  it('records the prompt and reply of an auxiliary call without touching the stream', async () => {
    const { ctx, spans } = liveSetup()
    const { s, append } = liveSession('A1')
    ctx.emit('session/created', s)
    append(ctx, 'turn/start', { turn: 1 })
    const chunks = [
      { type: 'reasoning-delta', text: 'think' },
      { type: 'text-delta', text: 'Fix ' },
      { type: 'text-delta', text: 'login' },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const options = {
      provider: 'deepseek', model: 'm', sessionId: 'A1', purpose: 'session-title', system: 'Write a title',
      messages: [{ role: 'user', content: 'help me fix login' }],
    }
    const seen: unknown[] = []
    const stream = await ctx.waterfall('llm/stream', options, () => (async function* () { yield* chunks })())
    for await (const c of stream as AsyncIterable<unknown>) seen.push(c)
    expect(seen).toEqual(chunks)
    const a = spans.find((x) => x.attributes['agent.custom.llm_purpose'] === 'session-title')!.attributes
    expect(a['gen_ai.input.messages']).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'help me fix login' }] }])
    expect(a['gen_ai.input.messages_delta']).toBeUndefined()
    expect(a['gen_ai.system_instructions']).toBe('Write a title')
    expect(a['gen_ai.output.messages']).toEqual([{ role: 'assistant', parts: [{ type: 'reasoning', content: 'think' }, { type: 'text', content: 'Fix login' }] }])
  })

  it('hashes the full context, rewrites it on compaction, and stays correct after releasing old bodies', () => {
    const { ctx, spans } = liveSetup()
    const run = (id: string, prompts: string[]) => {
      const { s, append } = liveSession(id)
      ctx.emit('session/created', s)
      prompts.forEach((p, i) => turn(ctx, append, i + 1, p, `a${i + 1}`))
      return { s, append }
    }
    run('H1', ['q1', 'q2'])
    run('H2', ['q1', 'q2'])
    run('H3', ['q1', 'qX'])
    const hashes = (id: string) => chats(spans).filter((x) => x.attributes['gen_ai.session.id'] === id).map((x) => x.attributes['gen_ai.input.messages.hash'])
    expect(hashes('H1')).toEqual(hashes('H2'))
    expect(hashes('H1')[0]).toBe(hashes('H3')[0])
    expect(hashes('H1')[1]).not.toBe(hashes('H3')[1])

    // A long session: old bodies are released, deltas stay exact.
    const { s, append } = liveSession('H4')
    ctx.emit('session/created', s)
    for (let i = 1; i <= 120; i++) turn(ctx, append, i, `q${i}`, `a${i}`)
    const long = chats(spans).filter((x) => x.attributes['gen_ai.session.id'] === 'H4')
    expect(long.at(-1)!.attributes['gen_ai.input.messages_delta']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'a119' }] },
      { role: 'user', parts: [{ type: 'text', content: 'q120' }] },
    ])
    expect(long.at(-1)!.attributes['agent.custom.input_message_count']).toBe(239)
    expect(long.at(-1)!.attributes['agent.custom.input_delta_start']).toBe(237)

    // Compaction replaces the history with a summary: full report of what remains, new hash.
    const before = long.at(-1)!.attributes['gen_ai.input.messages.hash']
    const log = (s as unknown as { snapshotEvents: () => SessionEvent[] }).snapshotEvents()
    const first = log.find((e) => e.type === 'user/message')!.seq
    const lastAnswer = [...log].reverse().find((e) => e.type === 'assistant/message')!.seq
    ctx.emit('session/event', s, { type: 'user/message', seq: log.length, time: Date.now(), surfaceOp: { op: 'replace', startSeq: first, endSeq: lastAnswer }, data: text('user', 'summary of 120 turns') } as SessionEvent)
    log.push({} as SessionEvent)
    turn(ctx, append, 121, 'q121', 'a121')
    const after = chats(spans).filter((x) => x.attributes['gen_ai.session.id'] === 'H4').at(-1)!.attributes
    expect(after['agent.custom.input_delta_reset']).toBe('context_shrank')
    expect((after['gen_ai.input.messages'] as { parts: { content: string }[] }[]).map((m) => m.parts[0]!.content)).toEqual(['summary of 120 turns', 'q121'])
    expect(after['gen_ai.input.messages.hash']).not.toBe(before)
  })

  it('passes an early stop and errors of the consumer through to the provider stream', async () => {
    const { ctx, spans } = liveSetup()
    const { s, append } = liveSession('Z1')
    ctx.emit('session/created', s)
    append(ctx, 'turn/start', { turn: 1 })
    let cancelled = false
    const options = { provider: 'deepseek', model: 'm', sessionId: 'Z1', purpose: 'compaction' }
    const stream = await ctx.waterfall('llm/stream', options, () => (async function* () {
      try {
        yield { type: 'text-delta', text: 'a' }
        yield { type: 'text-delta', text: 'b' }
      } finally { cancelled = true }
    })())
    for await (const _ of stream as AsyncIterable<unknown>) break
    expect(cancelled).toBe(true)
    expect(spans.filter((x) => x.attributes['agent.custom.llm_purpose'] === 'compaction')).toHaveLength(1)

    const failing = await ctx.waterfall('llm/stream', options, () => (async function* () { throw new Error('provider down') })())
    await expect((async () => { for await (const _ of failing as AsyncIterable<unknown>) { /* drain */ } })()).rejects.toThrow('provider down')
    expect(spans.filter((x) => x.attributes['agent.custom.llm_purpose'] === 'compaction')).toHaveLength(2)
  })

  it('places an auxiliary call in the round it belongs to', async () => {
    const { ctx, spans } = liveSetup()
    const { s, append } = liveSession('X1')
    ctx.emit('session/created', s)
    const run = async (purpose: string, during?: () => void) => {
      const stream = await ctx.waterfall('llm/stream', { provider: 'deepseek', model: 'm', sessionId: 'X1', purpose }, () => (async function* () {
        yield { type: 'text-delta', text: 'x' }
        during?.()
        yield { type: 'finish', reason: { kind: 'stop' } }
      })())
      for await (const _ of stream as AsyncIterable<unknown>) { /* drain */ }
    }
    append(ctx, 'turn/start', { turn: 1 })
    await run('compaction') // before step 1: prepares round 1
    append(ctx, 'step/start', { turn: 1, step: 1 })
    // Starts in round 1 and outlives the step and the turn.
    await run('session-title', () => {
      append(ctx, 'step/end', { turn: 1, step: 1 })
      append(ctx, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    })
    const by = (p: string) => spans.find((x) => x.attributes['agent.custom.llm_purpose'] === p)!
    const step = spans.find((x) => kind(x) === 'step')!
    const agent = spans.find((x) => kind(x) === 'agent')!
    expect(by('compaction').attributes['gen_ai.step.id']).toBe('X1:t1:s1')
    expect(by('compaction').parentSpanId).toBe(agent.spanId)
    expect(by('session-title').attributes['gen_ai.step.id']).toBe('X1:t1:s1')
    expect(by('session-title').parentSpanId).toBe(step.spanId)
    expect(by('session-title').traceId).toBe(step.traceId)
  })
})

