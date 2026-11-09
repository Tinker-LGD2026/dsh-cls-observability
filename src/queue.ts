/**
 * Batching export queue with retry plus a durable spill outbox.
 *
 * - push() is O(1) and never blocks the host; spans are sent shortly after they
 *   are produced (eager debounce), not only on a periodic tick.
 * - A single-flight sender drains spilled files first, then the memory buffer.
 * - stop() spills the remaining buffer synchronously BEFORE any network wait,
 *   so a host whose teardown blocks the event loop cannot lose the data.
 */
import { encodeGzipBody, exportBatch, exportGzipBody, type ExporterConfig, type ExportResult } from './exporter.ts'
import { recoverJournals, type Journal } from './journal.ts'
import type { Outbox } from './outbox.ts'
import { approxSpanBytes, spanBytes } from './size-limit.ts'
import type { Attributes, SpanRecord } from './otlp/types.ts'

export interface QueueOptions {
  exporter: ExporterConfig
  resource: Attributes
  scope: { name: string; version: string }
  maxBatchSpans: number
  flushIntervalMs: number
  /** Delay between a push and the eager send it triggers. */
  eagerDelayMs?: number
  maxQueueSpans: number
  /** Memory bound for queued spans (estimated bytes); overflow moves to the outbox. */
  maxQueueBytes?: number
  outbox?: Outbox
  /** Write-ahead journal: spans are on disk before they are sent. */
  journal?: Journal
  log: (level: 'debug' | 'warn', message: string) => void
  fetchImpl?: typeof fetch
}

export interface QueueStats {
  enqueued: number
  exported: number
  dropped: number
  retried: number
  rejected: number
  pending: number
  spilled: number
  recovered: number
}

export interface StopResult {
  delivered: boolean
  /** Undelivered spans were written to outbox files at stop. */
  spilled: boolean
}

const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000
const AUTH_PAUSE_MS = 5 * 60_000
const SPILL_FILE_BYTES = 4 * 1024 * 1024

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}

export class ExportQueue {
  private buffer: SpanRecord[] = []
  private running = false
  private stopped = false
  private timer?: NodeJS.Timeout
  private eagerTimer?: NodeJS.Timeout
  private wake?: () => void
  private backoffMs = 0
  private pausedUntil = 0
  private inflight?: Promise<boolean>
  private deadline?: number
  /** Batch whose request is currently in flight (a prefix of the buffer). */
  private sending?: SpanRecord[]
  /** Claimed spill file holding the in-flight batch, written at stop(). */
  private inflightSpill?: string
  /** A detached deliverer owns the outbox from stop() on. */
  private outboxHandedOff = false
  readonly stats: QueueStats = { enqueued: 0, exported: 0, dropped: 0, retried: 0, rejected: 0, pending: 0, spilled: 0, recovered: 0 }
  private readonly options: QueueOptions

  constructor(options: QueueOptions) {
    this.options = options
  }

  private sizes = new WeakMap<SpanRecord, number>()
  private bufferBytes = 0

  private maxBytes(): number {
    return this.options.maxQueueBytes ?? Number.POSITIVE_INFINITY
  }

  /** Remove spans from a buffer, keeping the byte account of the live buffer exact. */
  private take(buffer: SpanRecord[], start: number, count: number): void {
    const removed = buffer.splice(start, count)
    if (buffer !== this.buffer) return
    for (const span of removed) this.bufferBytes -= this.sizes.get(span) ?? 0
    if (buffer.length === 0) this.bufferBytes = 0
  }

  /** Enqueue a span. `urgent` (e.g. a turn just ended) wakes the sender immediately. */
  push(span: SpanRecord, urgent = false): void {
    if (this.stopped) return
    this.options.journal?.append(span)
    this.buffer.push(span)
    const size = approxSpanBytes(span)
    this.sizes.set(span, size)
    this.bufferBytes += size
    this.stats.enqueued++
    if (this.buffer.length > this.options.maxQueueSpans || this.bufferBytes > this.maxBytes()) this.overflow()
    this.stats.pending = this.buffer.length
    if (urgent || this.buffer.length >= this.options.maxBatchSpans) queueMicrotask(() => this.wake?.())
    else if (!this.eagerTimer) {
      this.eagerTimer = setTimeout(() => { this.eagerTimer = undefined; this.wake?.() }, this.options.eagerDelayMs ?? 200)
      this.eagerTimer.unref?.()
    }
  }

  /**
   * The destination has been unreachable long enough to fill memory: move the oldest
   * spans (never the batch in flight) to an outbox file instead of dropping them. Drop
   * only when the outbox cannot take them (disk full, over its size limit).
   */
  private overflow(): void {
    const inflight = this.sending && this.buffer[0] === this.sending[0] ? this.sending.length : 0
    let count = Math.max(this.buffer.length - this.options.maxQueueSpans, Math.min(this.options.maxBatchSpans, this.buffer.length - inflight))
    // Over the byte bound: take enough of the oldest spans to get back under it.
    let freed = 0
    for (let i = inflight; i < inflight + count; i++) freed += this.sizes.get(this.buffer[i]!) ?? 0
    for (let i = inflight + count; this.bufferBytes - freed > this.maxBytes() && i < this.buffer.length; i++, count++) freed += this.sizes.get(this.buffer[i]!) ?? 0
    const chunk = this.buffer.slice(inflight, inflight + count)
    const outbox = this.options.outbox
    if (outbox && this.spill(outbox, chunk)) {
      this.options.log('debug', `queue full: moved ${chunk.length} spans to the outbox`)
    } else {
      this.stats.dropped += chunk.length
      this.options.log('warn', `queue full: dropped ${chunk.length} oldest spans (total dropped ${this.stats.dropped})`)
    }
    this.take(this.buffer, inflight, chunk.length)
    this.options.journal?.ack(chunk)
  }

  start(): void {
    if (this.running) return
    this.running = true
    if (this.options.outbox) {
      const released = this.options.outbox.recoverStaleClaims()
      if (released > 0) this.options.log('debug', `released ${released} stale outbox claims`)
      // Journals of dead processes are read and re-encoded after the host has started,
      // not inside its plugin setup.
      const outbox = this.options.outbox
      setImmediate(() => {
        try {
          const recovered = recoverJournals(outbox, (m) => this.options.log('debug', m))
          if (recovered > 0) this.options.log('debug', `recovered ${recovered} spans journaled by an earlier process`)
        } catch { /* best effort: the next start or a deliverer retries */ }
      }).unref?.()
    }
    this.options.journal?.start()
    void this.loop()
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(() => { this.wake = undefined; resolve() }, ms)
      this.timer.unref?.()
      this.wake = () => { clearTimeout(this.timer); this.wake = undefined; resolve() }
    })
  }

  private async loop(): Promise<void> {
    let first = true
    while (this.running) {
      if (!first) {
        const waitFor = Math.max(this.backoffMs, this.pausedUntil - Date.now(), 0)
        await this.sleep(waitFor > 0 ? waitFor : this.options.flushIntervalMs)
        if (!this.running) break
      }
      first = false
      try {
        await this.drainOnce()
      } catch (error) {
        this.options.log('warn', `export loop error: ${String(error)}`)
      }
    }
  }

  /**
   * Single-flight drain: spilled files first (oldest data), then the memory
   * buffer. The background loop and a shutdown flush share one in-flight drain,
   * so nothing is sent twice concurrently. Returns whether everything was delivered.
   */
  private drainOnce(): Promise<boolean> {
    this.inflight ??= this.drainBody().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async drainBody(): Promise<boolean> {
    if (!(await this.drainOutbox())) return false
    // Capture the buffer: stop() may hand its contents to the outbox and replace it meanwhile.
    const buffer = this.buffer
    while (buffer.length > 0) {
      if (Date.now() < this.pausedUntil) return false
      const batch = buffer.slice(0, this.options.maxBatchSpans)
      this.sending = batch
      let ok = false
      try {
        ok = await this.sendWithIsolation(batch, buffer)
      } finally {
        this.sending = undefined
        this.settleInflightSpill(ok)
      }
      if (!ok) return false
      this.options.journal?.ack(batch)
      this.take(buffer, 0, batch.length)
      if (buffer === this.buffer) this.stats.pending = buffer.length
    }
    return this.buffer.length === 0
  }

  /** The in-flight batch was spilled as a claimed file at stop(): drop it on success, hand it over on failure. */
  private settleInflightSpill(ok: boolean): void {
    const file = this.inflightSpill
    if (!file || !this.options.outbox) return
    this.inflightSpill = undefined
    if (ok) this.options.outbox.remove(file)
    else this.options.outbox.release(file)
  }

  private async drainOutbox(): Promise<boolean> {
    const outbox = this.options.outbox
    if (!outbox || this.stopped || this.outboxHandedOff) return true
    for (const file of outbox.pending()) {
      if (Date.now() < this.pausedUntil) return false
      const claimed = outbox.claim(file)
      if (!claimed) continue
      const body = outbox.read(claimed)
      if (!body) { outbox.release(claimed); continue }
      const result = await exportGzipBody(this.boundedExporter(), body, this.options.fetchImpl)
      if (result.kind === 'ok' || result.kind === 'rejected') {
        outbox.remove(claimed)
        if (result.kind === 'ok') {
          this.stats.recovered++
          this.backoffMs = 0
          this.options.log('debug', `delivered spilled file ${file.slice(file.lastIndexOf('/') + 1)}`)
        } else {
          this.options.log('warn', `dropping rejected spill file: ${result.error}`)
        }
        continue
      }
      outbox.release(claimed)
      this.onFailure(result)
      return false
    }
    return true
  }

  private onFailure(result: Exclude<ExportResult, { kind: 'ok' } | { kind: 'rejected' }>): void {
    if (result.kind === 'auth' || result.kind === 'config') {
      this.pausedUntil = Date.now() + AUTH_PAUSE_MS
      const what = result.kind === 'auth' ? 'unauthorized' : 'destination not found (check topic and endpoint)'
      this.options.log('warn', `export ${what} (HTTP ${result.status}); pausing ${AUTH_PAUSE_MS / 1000}s, data kept: ${result.error}`)
      return
    }
    this.stats.retried++
    this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, this.backoffMs * 2))
    this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(this.backoffMs, result.retryAfterMs ?? 0)) + Math.floor(Math.random() * 250)
    this.options.log('warn', `export failed, retrying in ${this.backoffMs}ms: ${result.error}`)
  }

  /** Send one batch. A whole-batch 4xx rejection falls back to per-span isolation. */
  private async sendWithIsolation(batch: SpanRecord[], buffer: SpanRecord[]): Promise<boolean> {
    const result = await this.send(batch)
    switch (result.kind) {
      case 'ok':
        this.backoffMs = 0
        this.stats.exported += batch.length
        this.options.log('debug', `exported ${batch.length} spans (total ${this.stats.exported})`)
        return true
      case 'retryable':
      case 'auth':
      case 'config':
        this.onFailure(result)
        return false
      case 'rejected':
        if (batch.length === 1) {
          this.dropRejected(batch[0]!, result.error)
          return true
        }
        return this.sendIndividually(batch, buffer)
    }
  }

  private dropRejected(span: SpanRecord, error: string): void {
    this.stats.rejected++
    this.options.log('warn', `dropping rejected span ${span.name} trace=${span.traceId} span=${span.spanId}: ${error}`)
  }

  /**
   * Resend span by span so only offending spans are dropped. On a transient
   * failure, remove the settled prefix (the batch starts at the buffer head).
   */
  private async sendIndividually(batch: SpanRecord[], buffer: SpanRecord[]): Promise<boolean> {
    let settled = 0
    for (const span of batch) {
      const result = await this.send([span])
      if (result.kind === 'ok') this.stats.exported++
      else if (result.kind === 'rejected') this.dropRejected(span, result.error)
      else {
        this.options.journal?.ack(batch.slice(0, settled))
        this.take(buffer, 0, settled)
        if (buffer === this.buffer) this.stats.pending = buffer.length
        this.onFailure(result)
        return false
      }
      settled++
    }
    this.backoffMs = 0
    return true
  }

  private boundedExporter(): ExporterConfig {
    if (this.deadline === undefined) return this.options.exporter
    const remaining = this.deadline - Date.now()
    return { ...this.options.exporter, timeoutMs: Math.max(250, Math.min(this.options.exporter.timeoutMs, remaining)) }
  }

  private send(spans: SpanRecord[]): Promise<ExportResult> {
    const startedAt = Date.now()
    this.options.log('debug', `sending ${spans.length} spans`)
    return exportBatch(this.boundedExporter(), { resource: this.options.resource, scope: this.options.scope, spans }, this.options.fetchImpl).then((result) => {
      this.options.log('debug', `send finished: ${result.kind} in ${Date.now() - startedAt}ms`)
      return result
    })
  }

  /**
   * Best-effort flush within `timeoutMs` (ignores backoff, honours auth pause).
   * Individual requests are bounded by the remaining time.
   */
  async flush(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    this.deadline = deadline
    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now()
        const drained = await Promise.race([this.drainOnce(), delay(remaining).then(() => false)])
        // A drain that was already in flight may predate the spill; only an empty outbox counts.
        if (drained && this.buffer.length === 0 && (this.options.outbox?.pending().length ?? 0) === 0) return true
        if (Date.now() >= deadline || Date.now() < this.pausedUntil) break
        await delay(Math.min(250, deadline - Date.now()))
      }
      return this.buffer.length === 0
    } finally {
      this.deadline = undefined
    }
  }

  /**
   * Shutdown, ordered for hosts that may block the event loop or force-exit at any await:
   *  1. synchronously move every unsent span into the outbox (durable from here on);
   *  2. notify `onSpill` immediately (e.g. start a detached deliverer) — before any await;
   *  3. best-effort in-process delivery of the outbox within `timeoutMs`.
   * Outbox files are claimed atomically, so the in-process flush and a detached
   * deliverer never send the same file twice. The batch whose request is already
   * in flight is spilled as a file claimed by this process: removed when the
   * request succeeds, released on failure, and recovered at the next start if
   * this process dies first. Duplicates are limited to a request that succeeded
   * but whose response never arrived before the process died.
   */
  async stop(timeoutMs: number, onSpill?: () => boolean | void): Promise<StopResult> {
    this.running = false
    if (this.eagerTimer) clearTimeout(this.eagerTimer)
    this.wake?.()
    const outbox = this.options.outbox
    let spilled = false
    if (outbox && this.buffer.length > 0) {
      const inflight = this.sending && this.buffer[0] === this.sending[0] ? this.sending : undefined
      const rest = inflight ? this.buffer.slice(inflight.length) : this.buffer
      let ok = true
      if (inflight) {
        this.inflightSpill = this.spill(outbox, inflight, true)
        ok = this.inflightSpill !== undefined
      }
      if (rest.length > 0) {
        spilled = this.spillChunks(outbox, rest)
        ok = ok && spilled
      }
      if (ok) {
        // Empty in place: a drain already in flight holds this array and must not
        // continue with spans that now live in the outbox.
        this.take(this.buffer, 0, this.buffer.length)
        this.stats.pending = 0
        if (spilled) {
          try {
            // A detached deliverer now owns the outbox: sending it from this process too would
            // race it, and this host's event loop may stall mid-request (a late response looks
            // like a failure and re-queues data the server already accepted).
            this.outboxHandedOff = onSpill?.() === true
          } catch { /* best effort */ }
        }
      }
    }
    // Everything unsent now lives in outbox files: the journal is redundant. Done before
    // any await — the host may force-exit at any point after this.
    const journal = this.options.journal
    if (journal && this.buffer.length === 0) journal.discard()
    let delivered = await this.flush(timeoutMs)
    if (!delivered && this.inflight) {
      // The host may have blocked the event loop past our deadline while a request was
      // in flight; its response is often already buffered once the loop resumes.
      await Promise.race([this.inflight, delay(500)])
      delivered = this.buffer.length === 0
    }
    if (outbox && !this.outboxHandedOff) delivered = delivered && outbox.pending().length === 0 && this.inflightSpill === undefined
    this.stopped = true
    if (this.outboxHandedOff) {
      this.options.log('debug', 'shutdown: outbox handed to the detached deliverer')
    } else if (!delivered) {
      if (outbox && outbox.pending().length > 0) {
        this.options.log('debug', `shutdown: ${outbox.pending().length} outbox files kept for later delivery`)
      } else if (this.buffer.length > 0 && journal?.active) {
        this.options.log('warn', `shutdown: ${this.buffer.length} spans not delivered within ${timeoutMs}ms; kept in the journal for the next start`)
      } else if (this.buffer.length > 0) {
        this.stats.dropped += this.buffer.length
        this.options.log('warn', `shutdown: ${this.buffer.length} spans not delivered within ${timeoutMs}ms and could not be spilled`)
      }
    }
    // Spill failed: unsent spans stay journaled (acks above kept it exact).
    journal?.release()
    this.buffer = []
    this.bufferBytes = 0
    this.stats.pending = 0
    return { delivered, spilled }
  }

  /**
   * Spill in files of at most `maxBatchSpans` spans and ~4 MiB: one huge file would be one
   * huge request (413 risk) and an all-or-nothing unit of delivery.
   */
  private spillChunks(outbox: Outbox, spans: SpanRecord[]): boolean {
    let chunk: SpanRecord[] = []
    let bytes = 0
    const flushChunk = () => {
      if (chunk.length === 0) return true
      const ok = this.spill(outbox, chunk) !== undefined
      chunk = []
      bytes = 0
      return ok
    }
    for (const span of spans) {
      const size = spanBytes(span)
      if (chunk.length > 0 && (chunk.length >= this.options.maxBatchSpans || bytes + size > SPILL_FILE_BYTES)) {
        if (!flushChunk()) return false
      }
      chunk.push(span)
      bytes += size
    }
    return flushChunk()
  }

  private spill(outbox: Outbox, spans: SpanRecord[], claimed = false): string | undefined {
    try {
      const file = outbox.spillSync(encodeGzipBody({ resource: this.options.resource, scope: this.options.scope, spans }), claimed)
      if (file) this.stats.spilled += spans.length
      return file
    } catch (error) {
      this.options.log('warn', `spill failed: ${String(error)}`)
      return undefined
    }
  }
}
