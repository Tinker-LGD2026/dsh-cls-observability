/**
 * Offline replay: read a DSH session log (session.v4.jsonl[.zstd]) and rebuild
 * spans with the same builder as the live collector.
 */
import { readFileSync } from 'node:fs'
import * as zlib from 'node:zlib'
import type { SessionEvent, SessionHeader } from './dsh-types.ts'
import type { SpanRecord } from './otlp/types.ts'
import { catalogEntry, SessionTracer, type BuilderOptions, type CatalogEntry, type NameResolver, type RootResolver } from './trace-builder.ts'

export interface SessionLog {
  header: SessionHeader
  inheritedEventCount: number
  events: SessionEvent[]
}

function decompress(bytes: Buffer, file: string): string {
  if (!file.endsWith('.zstd') && !file.endsWith('.zst')) return bytes.toString('utf8')
  const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
  if (!zstd) throw new Error('zstd decompression requires Node.js >= 23.8')
  return zstd(bytes).toString('utf8')
}

/**
 * Parse a session log. Recorded fixtures may omit `seq`/`time`; seq then
 * defaults to the event's position and time to a synthetic monotone clock.
 */
export function parseSessionLog(text: string): SessionLog {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) throw new Error('empty session log')
  const head = JSON.parse(lines[0]!) as Record<string, unknown>
  const header: SessionHeader = {
    id: String(head.id),
    createdAt: Number(head.createdAt ?? 0),
    isSeeded: head.isSeeded === true,
    ...(typeof head.cwd === 'string' ? { cwd: head.cwd } : {}),
    ...(typeof head.parentSession === 'string' ? { parentSession: head.parentSession } : {}),
    ...(head.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
    ...(typeof head.delegationDepth === 'number' ? { delegationDepth: head.delegationDepth } : {}),
    ...(typeof head.agentPreset === 'string' ? { agentPreset: head.agentPreset } : {}),
  }
  let clock = header.createdAt || 0
  const events: SessionEvent[] = []
  for (let i = 1; i < lines.length; i++) {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(lines[i]!) as Record<string, unknown>
    } catch {
      break // torn tail after a crash: stop at the first unreadable line
    }
    const seq = typeof raw.seq === 'number' ? raw.seq : events.length
    const time = typeof raw.time === 'number' ? raw.time : (clock += 10)
    if (typeof raw.time === 'number') clock = raw.time
    events.push({ ...(raw as object), type: String(raw.type), seq, time, data: raw.data } as SessionEvent)
  }
  let inheritedEventCount = typeof head.inheritedEventCount === 'number' ? head.inheritedEventCount : 0
  if (header.isSeeded && typeof head.inheritedEventCount !== 'number') {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if (e.type === 'session/end-seed' && e.data?.inherited === true) {
        inheritedEventCount = e.seq
        break
      }
    }
  }
  return { header, inheritedEventCount, events }
}

export function readSessionLog(file: string): SessionLog {
  return parseSessionLog(decompress(readFileSync(file), file))
}

export function replaySession(log: SessionLog, options: Omit<BuilderOptions, 'source'>, resolveName?: NameResolver, resolveRoot?: RootResolver): SpanRecord[] {
  const spans: SpanRecord[] = []
  const tracer = new SessionTracer(
    { sessionId: log.header.id, header: log.header, inheritedEventCount: log.inheritedEventCount },
    { ...options, source: 'replay' },
    (span) => spans.push(span),
    undefined,
    resolveName,
    resolveRoot,
  )
  for (const event of log.events) tracer.onEvent(event)
  return spans
}

/** Child names from every parent's `subagent/catalog`, keyed `${parentId}|${childId}`. */
export function catalogNames(logs: readonly SessionLog[]): NameResolver {
  const names = new Map<string, CatalogEntry>()
  for (const log of logs) {
    for (const e of log.events) {
      const entry = e.type === 'subagent/catalog' ? catalogEntry(e.data) : undefined
      if (entry) names.set(`${log.header.id}|${entry.childId}`, entry)
    }
  }
  return (parent, child) => names.get(`${parent}|${child}`)
}

/** Root session (task) of each log, following subagent parents present in the group. */
export function taskRoots(logs: readonly SessionLog[]): RootResolver {
  const parent = new Map<string, string | undefined>()
  for (const log of logs) parent.set(log.header.id, log.header.origin === 'subagent' ? log.header.parentSession : undefined)
  return (id) => {
    if (!parent.has(id)) return undefined
    let current = id
    for (let hops = 0; hops < 64; hops++) {
      const up = parent.get(current)
      if (!up) return current
      if (!parent.has(up)) return up
      current = up
    }
    return current
  }
}

/** Replay related sessions together (parents resolve their subagents' names and task). */
export function replaySessionGroup(logs: readonly SessionLog[], options: Omit<BuilderOptions, 'source'>): SpanRecord[][] {
  const resolve = catalogNames(logs)
  const roots = taskRoots(logs)
  return logs.map((log) => replaySession(log, options, resolve, roots))
}
