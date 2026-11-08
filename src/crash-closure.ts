/**
 * Closing turns left open by a crash.
 *
 * When DSH resumes a session whose last turn never ended, it appends synthetic closers to
 * the log (error results for unanswered tool calls, `step/end` for an open step,
 * `turn/end{interrupted}`) as part of the restored seed; they never pass through
 * `session/event`. Without them the turn has no entry / agent root in the trace.
 *
 * The closers reuse the timestamp of the last real event and carry no explicit marker, so
 * they are recognised by shape: tool results whose message id starts with
 * `interrupted-tool-result-`, an optional `step/end` with the same timestamp as the event
 * before it, and the final `turn/end{interrupted}`.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { SessionEvent } from './dsh-types.ts'

export interface InterruptedTail {
  turn: number
  /** Index of the turn's `turn/start` in the events. */
  regionStart: number
  /** Index of the first synthetic closer. */
  closerStart: number
}

const isSyntheticResult = (e: SessionEvent | undefined) =>
  e?.type === 'tool/result' && String((e.data as { message?: { id?: unknown } })?.message?.id ?? '').startsWith('interrupted-tool-result-')

/** Events that shape turns; anything else (seed markers, titles, jobs, …) may trail the closers. */
const isStructural = (e: SessionEvent) =>
  e.type.startsWith('turn/') || e.type.startsWith('step/') || e.type.startsWith('tool/') || e.type === 'assistant/message' || e.type === 'user/message'

/** The crash-closed turn at the end of a restored log, if any. */
export function interruptedTail(events: readonly SessionEvent[]): InterruptedTail | undefined {
  // On resume DSH 0.2.2 appends `session/end-seed` (and may append other markers) after the
  // closers; look past them for the last turn-shaping event.
  let n = events.length
  while (n > 0 && !isStructural(events[n - 1]!)) n--
  const last = events[n - 1]
  const reason = (last?.data as { reason?: { kind?: unknown } } | undefined)?.reason
  if (!last || last.type !== 'turn/end' || reason?.kind !== 'interrupted') return undefined
  let i = n - 1
  const step = events[i - 1]
  if (step?.type === 'step/end') {
    const before = events[i - 2]
    if (before && (isSyntheticResult(before) || before.time === step.time)) i--
  }
  while (isSyntheticResult(events[i - 1])) i--
  const turn = Number((last.data as { turn?: unknown }).turn)
  let regionStart = -1
  for (let k = i - 1; k >= 0; k--) {
    const e = events[k]!
    if (e.type === 'turn/start' && Number((e.data as { turn?: unknown }).turn) === turn) { regionStart = k; break }
  }
  if (regionStart < 0) return undefined
  return { turn, regionStart, closerStart: i }
}

/** Turns already closed after a crash, shared by all processes using the same outbox. */
export interface ClosedTurns {
  has(key: string): boolean
  add(key: string): void
}

export class ClosedTurnsFile implements ClosedTurns {
  private readonly file: string
  private keys?: Set<string>

  constructor(dir: string) {
    this.file = path.join(dir, 'closed-turns')
  }

  has(key: string): boolean {
    return this.load().has(key)
  }

  add(key: string): void {
    this.load().add(key)
    try { appendFileSync(this.file, `${key}\n`, { mode: 0o600 }) } catch { /* best effort */ }
  }

  private load(): Set<string> {
    // Re-read every time: another process may have closed the turn meanwhile. Rare path.
    let lines: string[] = []
    try { lines = readFileSync(this.file, 'utf8').split('\n') } catch { /* none yet */ }
    this.keys = new Set([...(this.keys ?? []), ...lines.filter(Boolean)])
    return this.keys
  }
}
