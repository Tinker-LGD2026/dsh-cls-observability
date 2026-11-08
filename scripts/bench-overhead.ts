/**
 * DEV ONLY. Host overhead of the live collector: time spent inside DSH event callbacks
 * and retained memory, with content capture and redaction on (the worst case).
 *
 * Simulates long-running sessions: each turn = user message, then 4 steps of
 * (assistant attempt with tool call + tool call/result of ~4 KB), then a final answer.
 * Targets (design doc): callback P99 < 1 ms, plugin memory < 64 MiB.
 *   node --expose-gc scripts/bench-overhead.ts [sessions] [turns]
 */
import { Collector } from '../src/collector.ts'
import type { SessionEvent, SessionLike } from '../src/dsh-types.ts'
import { BUILTIN_RULES, Redactor } from '../src/redact.ts'
import { limitSpanSize } from '../src/size-limit.ts'

const sessions = Number(process.argv[2] ?? 20)
const turns = Number(process.argv[3] ?? 50)
// The host owns session logs; drop them here so retained heap is the plugin's.
const keepLogs = false

type Listener = (...args: unknown[]) => unknown
const listeners = new Map<string, Listener[]>()
const ctx = {
  on(name: string, fn: Listener) { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => {} },
  effect() {},
  inject() {},
  get() { return undefined },
}
let exported = 0
new Collector({
  builder: { captureContent: true, maxContentChars: 32_000, commonAttributes: {}, redactor: new Redactor(BUILTIN_RULES) },
  includeAuxiliary: true,
  sampleRatio: 1,
  // Same per-span work as the plugin entry: size guard before queueing.
  emit: (span) => { limitSpanSize(span); exported++ },
  log: () => {},
}).attach(ctx as never)

const samples: number[] = []
const emit = (name: string, ...args: unknown[]) => {
  for (const fn of listeners.get(name) ?? []) {
    const t = performance.now()
    fn(...args)
    samples.push(performance.now() - t)
  }
}

const filler = (n: number, seed: number) => {
  let s = ''
  while (s.length < n) s += `line ${seed} of tool output: lorem ipsum dolor sit amet, consectetur adipiscing elit ${s.length}\n`
  return s.slice(0, n)
}

const gc = (globalThis as { gc?: () => void }).gc
gc?.()
const heapBefore = process.memoryUsage().heapUsed
const wall = performance.now()
const all: { s: SessionLike; log: SessionEvent[]; seq?: number }[] = []
for (let k = 0; k < sessions; k++) {
  const log: SessionEvent[] = []
  const s = { id: `bench-${k}`, header: { id: `bench-${k}`, createdAt: 0, isSeeded: false }, inheritedEventCount: 0, firstLiveSeq: 0, firstLifecycleSeq: 0, snapshotEvents: () => log } as SessionLike
  all.push({ s, log })
  emit('session/created', s)
}
const ev = (x: { s: SessionLike; log: SessionEvent[]; seq?: number }, type: string, data: unknown, surfaceOp?: 'append') => {
  const e = { type, seq: x.seq ?? 0, time: Date.now(), data, ...(surfaceOp ? { surfaceOp } : {}) } as SessionEvent
  x.log.push(e)
  if (!keepLogs && x.log.length > 4) x.log.splice(0, x.log.length - 4)
  x.seq = (x.seq ?? 0) + 1
  emit('session/event', x.s, e)
}
const usage = { inputTokens: 9000, outputTokens: 120, cacheReadTokens: 8000 }
const turnCost: number[] = []
for (let t = 1; t <= turns; t++) {
  const before = samples.reduce((a, b) => a + b, 0)
  for (const x of all) {
    ev(x, 'turn/start', { turn: t })
    ev(x, 'user/message', { role: 'user', content: [{ type: 'text', text: `request ${t}: ${filler(600, t)}` }], source: { kind: 'user' } }, 'append')
    for (let st = 1; st <= 5; st++) {
      ev(x, 'step/start', { turn: t, step: st })
      const last = st === 5
      const content = last
        ? [{ type: 'text', text: `answer ${t}: ${filler(800, st)}` }]
        : [{ type: 'reasoning', text: filler(300, st) }, { type: 'tool-call', id: `c${t}-${st}`, name: 'bash', arguments: JSON.stringify({ command: `cat file-${st}.txt` }) }]
      const finish = { type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: last ? 'stop' : 'tool-calls' } } }
      const use = { type: 'chunk', time: Date.now(), chunk: { type: 'usage', usage } }
      ev(x, 'assistant/message', { turn: t, step: st, message: { role: 'assistant', content, source: { kind: 'model' } }, stream: [use, finish] }, 'append')
      if (!last) {
        ev(x, 'tool/call', { turn: t, step: st, callId: `c${t}-${st}`, name: 'bash', arguments: JSON.stringify({ command: `cat file-${st}.txt` }) })
        ev(x, 'tool/result', { turn: t, step: st, message: { role: 'tool', toolCallId: `c${t}-${st}`, content: [{ type: 'text', text: filler(4_000, st) }], source: { kind: 'tool', callId: `c${t}-${st}` } } }, 'append')
      }
      ev(x, 'step/end', { turn: t, step: st })
    }
    ev(x, 'turn/end', { turn: t, reason: { kind: 'completed' } })
  }
  turnCost.push(samples.reduce((a, b) => a + b, 0) - before)
}
const elapsed = performance.now() - wall
gc?.()
const heapAfter = process.memoryUsage().heapUsed
// The bench keeps every session log alive itself; subtract that to isolate the plugin.

samples.sort((a, b) => a - b)
const pct = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!
const events = all.reduce((n, x) => n + (x.seq ?? 0), 0)
console.log(`sessions=${sessions} turns=${turns} events=${events} spans=${exported} callbacks=${samples.length}`)
console.log(`callback ms: p50=${pct(0.5).toFixed(3)} p90=${pct(0.9).toFixed(3)} p99=${pct(0.99).toFixed(3)} max=${samples.at(-1)!.toFixed(3)} mean=${(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(3)}`)
console.log(`throughput: ${(events / (elapsed / 1000)).toFixed(0)} events/s`)
console.log(`plugin retained heap: ${((heapAfter - heapBefore) / 2 ** 20).toFixed(1)} MiB for ${sessions} open sessions${gc ? '' : ' (run with --expose-gc for stable numbers)'}`)
// Per-turn cost late vs early: does a long session slow callbacks down?
const perTurn = turnCost.map((v) => v / sessions)
console.log(`mean callback time per turn: first 5 turns ${(perTurn.slice(0, 5).reduce((a, b) => a + b, 0) / 5).toFixed(2)} ms, last 5 turns ${(perTurn.slice(-5).reduce((a, b) => a + b, 0) / 5).toFixed(2)} ms`)
