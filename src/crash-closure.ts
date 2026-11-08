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
import { appendFileSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * What a process already emitted for turns that have not ended yet.
 *
 * DSH dispatches session events to plugins before the session log is durably written. A
 * host killed in between leaves the plugin having emitted (and journaled) spans for events
 * the log does not contain; on resume DSH appends crash closers for those same events and
 * a naive closure would emit the same span ids again. Each process therefore records, per
 * open turn, the step / tool span ids it emitted and when a turn ended; crash closure skips
 * those spans, and skips a turn entirely when it in fact ended.
 *
 * Files: `<dir>/open-spans-<pid>` (this process, rewritten to the open turns only now and
 * then) and `<dir>/open-spans` (open turns of dead processes, folded in at start).
 * Lines: `+ <turnKey> <spanId>` and `- <turnKey>` (turn ended).
 */
export interface EmittedSpans {
  /** Span ids emitted for a turn, and whether the turn ended in that process. */
  lookup(turnKey: string): { spanIds: Set<string>; ended: boolean }
}

/** `<DSH session id>:t<N>`, the key crash closure uses; undefined for spans of no turn. */
export function turnKeyOf(attributes: Record<string, unknown>): string | undefined {
  const agentId = attributes['gen_ai.agent.id']
  const turn = /:t(\d+)$/.exec(String(attributes['gen_ai.turn.id'] ?? ''))?.[1]
  return typeof agentId === 'string' && turn ? `${agentId}:t${turn}` : undefined
}

const SHARED = 'open-spans'
const OWN_PREFIX = 'open-spans-'
const REWRITE_EVERY = 2_000

export class OpenSpansLedger implements EmittedSpans {
  private readonly dir: string
  private readonly own: string
  private readonly open = new Map<string, Set<string>>()
  private appended = 0
  private failed = false

  constructor(dir: string) {
    this.dir = dir
    this.own = path.join(dir, `${OWN_PREFIX}${process.pid}`)
  }

  /** Fold the ledgers of dead processes into the shared file (call once at start). */
  foldDead(alive: (pid: number) => boolean): void {
    let entries: string[] = []
    try { entries = readdirSync(this.dir) } catch { return }
    for (const entry of entries) {
      if (!entry.startsWith(OWN_PREFIX)) continue
      const pid = Number(entry.slice(OWN_PREFIX.length))
      if (!Number.isInteger(pid) || pid === process.pid || alive(pid)) continue
      const file = path.join(this.dir, entry)
      try {
        const { open, ended } = parse(readFileSync(file, 'utf8'))
        const lines: string[] = []
        for (const [turn, ids] of open) for (const id of ids) lines.push(`+ ${turn} ${id}`)
        for (const turn of ended) lines.push(`- ${turn}`)
        if (lines.length > 0) appendFileSync(path.join(this.dir, SHARED), `${lines.join('\n')}\n`, { mode: 0o600 })
        rmSync(file, { force: true })
      } catch { /* leave it for the next start */ }
    }
  }

  /** Record an emitted span (live process). Never throws. */
  record(span: { spanId: string; attributes: Record<string, unknown> }): void {
    if (this.failed) return
    const kind = span.attributes['gen_ai.span.kind']
    const turn = turnKeyOf(span.attributes)
    if (!turn) return
    try {
      if (kind === 'step' || kind === 'tool') {
        let ids = this.open.get(turn)
        if (!ids) this.open.set(turn, (ids = new Set()))
        ids.add(span.spanId)
        this.write(`+ ${turn} ${span.spanId}\n`)
      } else if (kind === 'agent') {
        // The agent span is emitted exactly when a turn ends (with or without an entry).
        this.open.delete(turn)
        this.write(`- ${turn}\n`)
      }
      if (++this.appended >= REWRITE_EVERY) this.rewrite()
    } catch {
      this.failed = true
    }
  }

  /** Clean shutdown: keep only turns still open (DSH closes them on resume). */
  close(): void {
    try {
      if (this.open.size === 0) rmSync(this.own, { force: true })
      else this.rewrite()
    } catch { /* best effort */ }
  }

  lookup(turnKey: string): { spanIds: Set<string>; ended: boolean } {
    const spanIds = new Set<string>()
    let ended = false
    const files = [SHARED]
    try { for (const e of readdirSync(this.dir)) if (e.startsWith(OWN_PREFIX) && e !== path.basename(this.own)) files.push(e) } catch { /* none */ }
    for (const f of files) {
      let text = ''
      try { text = readFileSync(path.join(this.dir, f), 'utf8') } catch { continue }
      const parsed = parse(text)
      for (const id of parsed.open.get(turnKey) ?? []) spanIds.add(id)
      for (const id of parsed.all.get(turnKey) ?? []) spanIds.add(id)
      if (parsed.ended.has(turnKey)) ended = true
    }
    return { spanIds, ended }
  }

  private write(line: string): void {
    appendFileSync(this.own, line, { mode: 0o600 })
  }

  private rewrite(): void {
    const lines: string[] = []
    for (const [turn, ids] of this.open) for (const id of ids) lines.push(`+ ${turn} ${id}`)
    const tmp = `${this.own}.tmp`
    writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
    renameSync(tmp, this.own)
    this.appended = 0
  }
}

function parse(text: string): { open: Map<string, Set<string>>; all: Map<string, Set<string>>; ended: Set<string> } {
  const open = new Map<string, Set<string>>()
  const all = new Map<string, Set<string>>()
  const ended = new Set<string>()
  for (const line of text.split('\n')) {
    const [op, turn, id] = line.split(' ')
    if (!turn) continue
    if (op === '+' && id) {
      for (const m of [open, all]) {
        let ids = m.get(turn)
        if (!ids) m.set(turn, (ids = new Set()))
        ids.add(id)
      }
    } else if (op === '-') {
      ended.add(turn)
      open.delete(turn)
    }
  }
  return { open, all, ended }
}
