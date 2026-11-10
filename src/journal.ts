/**
 * Write-ahead journal: every span is appended to disk before it is sent, so a crashed
 * host (kill -9, OOM, power loss after the next sync) loses nothing that was produced.
 *
 * Files live in the outbox directory as `<ts>-<pid>-<rand>.wal`, claimed by the writing
 * process (`.wal.sending-<pid>`) while it runs. JSON lines:
 *   {"h":1,"resource":…,"scope":…}   header
 *   {"s":<span>}                     a span to deliver
 *   {"a":["<trace>:<span>",…]}       spans acknowledged (sent, rejected or handed to an outbox file)
 * A closed segment whose spans are all acknowledged is deleted. When the writer dies, its
 * claim is released and the next plugin start (or the detached deliverer) converts the
 * unacknowledged spans of the segment into regular outbox files.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, fdatasync, fdatasyncSync, futimes, openSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeSync } from 'node:fs'
import path from 'node:path'
import { encodeGzipBody } from './exporter.ts'
import type { Attributes, SpanRecord } from './otlp/types.ts'
import { HEARTBEAT_MS, OWNER, type Outbox } from './outbox.ts'

const SUFFIX = '.wal'
const CLAIM = '.sending-'
/** A segment is closed for new spans beyond this size. */
const SEGMENT_BYTES = 4 * 1024 * 1024
/** Spans per outbox file written when a journal is recovered. */
const RECOVER_BATCH = 512

export interface JournalHeader {
  resource: Attributes
  scope: { name: string; version: string }
}

interface Segment {
  file: string
  fd: number
  bytes: number
  closed: boolean
  live: Set<string>
}

const key = (s: SpanRecord) => `${s.traceId}:${s.spanId}`

/** JSON with bigint support (span times are nanosecond bigints). */
function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v))
}

function decode(line: string): unknown {
  return JSON.parse(line, (_k, v) => (v !== null && typeof v === 'object' && typeof (v as { $bigint?: unknown }).$bigint === 'string' && Object.keys(v).length === 1
    ? BigInt((v as { $bigint: string }).$bigint)
    : v))
}

export class Journal {
  readonly dir: string
  private readonly header: string
  private readonly log: (level: 'debug' | 'warn', message: string) => void
  private current?: Segment
  private readonly segments = new Set<Segment>()
  private readonly owner = new WeakMap<SpanRecord, Segment>()
  private readonly dirty = new Set<Segment>()
  private timer?: NodeJS.Timeout
  private failed = false
  private finished = false

  constructor(dir: string, header: JournalHeader, log: (level: 'debug' | 'warn', message: string) => void) {
    this.dir = dir
    this.header = encode({ h: 1, resource: header.resource, scope: header.scope })
    this.log = log
  }

  /** Whether spans are currently being journaled (false after an IO failure or finish). */
  get active(): boolean {
    return !this.failed && !this.finished
  }

  /** Append one span. Never throws: an IO failure disables the journal for this process. */
  append(span: SpanRecord): void {
    if (!this.active) return
    try {
      const seg = this.segment()
      this.write(seg, encode({ s: span }))
      seg.live.add(key(span))
      this.owner.set(span, seg)
      if (seg.bytes > SEGMENT_BYTES) seg.closed = true
    } catch (error) {
      this.fail(error)
    }
  }

  /** Record spans as settled; deletes closed segments that no longer hold live spans. */
  ack(spans: readonly SpanRecord[]): void {
    if (!this.active || spans.length === 0) return
    const bySeg = new Map<Segment, string[]>()
    for (const span of spans) {
      const seg = this.owner.get(span)
      if (!seg || !seg.live.has(key(span))) continue
      bySeg.set(seg, [...(bySeg.get(seg) ?? []), key(span)])
    }
    try {
      for (const [seg, keys] of bySeg) {
        for (const k of keys) seg.live.delete(k)
        if (seg.closed && seg.live.size === 0) this.drop(seg)
        else this.write(seg, encode({ a: keys }))
      }
    } catch (error) {
      this.fail(error)
    }
  }

  /** fsync segments written since the last sync, synchronously (used before handing off). */
  sync(): void {
    for (const seg of this.dirty) {
      try { fdatasyncSync(seg.fd) } catch { /* best effort */ }
    }
    this.dirty.clear()
  }

  /**
   * The periodic fsync runs on the libuv thread pool: on network or overlay filesystems it
   * can take tens of milliseconds, which must not stall the host's event loop.
   */
  private syncAsync(): void {
    for (const seg of this.dirty) {
      // Rotated segments included: they may hold writes made just before rotation.
      fdatasync(seg.fd, () => { /* best effort; EBADF if the segment was dropped meanwhile */ })
    }
    this.dirty.clear()
  }

  /** Start periodic fsync. */
  start(intervalMs = 200): void {
    if (this.timer) return
    let beat = Date.now()
    this.timer = setInterval(() => {
      this.syncAsync()
      // Heartbeat: an idle host's journal must not look abandoned to a relay in another
      // PID namespace (claims from other namespaces are judged by file age).
      if (Date.now() - beat > HEARTBEAT_MS) {
        beat = Date.now()
        for (const seg of this.segments) futimes(seg.fd, new Date(), new Date(), () => {})
      }
    }, intervalMs)
    this.timer.unref?.()
  }

  /** Everything unsent is now durable elsewhere (spilled to outbox files): delete the journal. */
  discard(): void {
    this.finish((seg) => this.drop(seg))
  }

  /** Stop journaling but keep segments with live spans for the next start to recover. */
  release(): void {
    this.finish((seg) => {
      if (seg.live.size === 0) return this.drop(seg)
      try { fdatasyncSync(seg.fd) } catch { /* best effort */ }
      try { closeSync(seg.fd) } catch { /* already closed */ }
      try { renameSync(seg.file, seg.file.slice(0, seg.file.lastIndexOf(CLAIM))) } catch { /* left claimed: recovered once this pid is gone */ }
    })
  }

  private finish(each: (seg: Segment) => void): void {
    if (this.finished) return
    this.finished = true
    if (this.timer) clearInterval(this.timer)
    for (const seg of [...this.segments]) each(seg)
    this.segments.clear()
    this.dirty.clear()
    this.current = undefined
  }

  private segment(): Segment {
    if (this.current && !this.current.closed) return this.current
    const name = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}${SUFFIX}${CLAIM}${OWNER}`
    const file = path.join(this.dir, name)
    const seg: Segment = { file, fd: openSync(file, 'a', 0o600), bytes: 0, closed: false, live: new Set() }
    this.segments.add(seg)
    this.current = seg
    this.write(seg, this.header)
    return seg
  }

  private write(seg: Segment, line: string): void {
    const data = `${line}\n`
    writeSync(seg.fd, data)
    seg.bytes += Buffer.byteLength(data)
    this.dirty.add(seg)
  }

  private drop(seg: Segment): void {
    this.segments.delete(seg)
    this.dirty.delete(seg)
    if (this.current === seg) this.current = undefined
    try { closeSync(seg.fd) } catch { /* already closed */ }
    try { rmSync(seg.file, { force: true }) } catch { /* best effort: settled spans only */ }
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    this.log('warn', `write-ahead journal disabled (${String(error)}); spans are kept in memory only`)
  }
}

/**
 * Convert journals left by dead processes (unclaimed `.wal` files) into outbox files.
 * Safe to run concurrently from several processes: each file is claimed atomically first.
 * Returns the number of spans recovered.
 */
export function recoverJournals(outbox: Outbox, log: (message: string) => void = () => {}): number {
  let entries: string[] = []
  try { entries = readdirSync(outbox.dir).filter((f) => f.endsWith(SUFFIX)).sort() } catch { return 0 }
  let recovered = 0
  for (const entry of entries) {
    const file = path.join(outbox.dir, entry)
    const claimed = `${file}${CLAIM}${OWNER}`
    try { renameSync(file, claimed) } catch { continue }
    try { const now = new Date(); utimesSync(claimed, now, now) } catch { /* best effort */ }
    try {
      const { header, spans } = readJournal(readFileSync(claimed, 'utf8'))
      let ok = true
      for (let i = 0; ok && header && i < spans.length; i += RECOVER_BATCH) {
        const body = encodeGzipBody({ resource: header.resource, scope: header.scope, spans: spans.slice(i, i + RECOVER_BATCH) })
        ok = outbox.spillSync(body) !== undefined
      }
      if (ok) {
        rmSync(claimed, { force: true })
        recovered += spans.length
        if (spans.length > 0) log(`recovered ${spans.length} spans from ${entry}`)
      } else {
        renameSync(claimed, file)
        log(`could not recover ${entry} (outbox full or not writable); kept for later`)
      }
    } catch (error) {
      // Unreadable journal: keep it out of the way instead of retrying forever.
      try { renameSync(claimed, `${file}.corrupt`) } catch { /* ignore */ }
      log(`unreadable journal ${entry}: ${String(error)}`)
    }
  }
  return recovered
}

/** Parse a journal: the header and the spans not acknowledged. A torn last line is ignored. */
export function readJournal(text: string): { header?: JournalHeader; spans: SpanRecord[] } {
  let header: JournalHeader | undefined
  const spans = new Map<string, SpanRecord>()
  for (const line of text.split('\n')) {
    if (!line) continue
    let record: { h?: number; resource?: Attributes; scope?: JournalHeader['scope']; s?: SpanRecord; a?: string[] }
    try { record = decode(line) as typeof record } catch { continue }
    if (record.h !== undefined && record.resource && record.scope) header = { resource: record.resource, scope: record.scope }
    else if (record.s) spans.set(key(record.s), record.s)
    else if (record.a) for (const k of record.a) spans.delete(k)
  }
  return { ...(header ? { header } : {}), spans: [...spans.values()] }
}
