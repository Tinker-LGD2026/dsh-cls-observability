/**
 * Durable spill directory for spans that could not be delivered before the
 * host process exits.
 *
 * Why synchronous: DSH disposes plugins right after a one-shot run, and other
 * plugins' teardown can block the event loop for seconds, starving any async
 * network flush. Spilling is a few milliseconds of sync IO and cannot be starved.
 *
 * Files: `<ms>-<pid>-<rand>.otlp.gz` = one gzip OTLP ExportTraceServiceRequest.
 * Claiming renames to `<name>.sending-<pid>` so concurrent senders never double-send;
 * claims left by dead processes are released on the next start.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const SUFFIX = '.otlp.gz'
const CLAIM = '.sending-'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class Outbox {
  readonly dir: string
  private readonly maxBytes: number

  constructor(dir: string, maxBytes = 512 * 1024 * 1024) {
    this.dir = dir
    this.maxBytes = maxBytes
  }

  /** Create the directory; returns false when it is not writable (read-only filesystem). */
  ensure(): boolean {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      return true
    } catch {
      return false
    }
  }

  /**
   * Atomically write one request body; returns the file path, or undefined on
   * failure / over capacity. `claimed` writes it already claimed by this process
   * (for a batch whose request is in flight): other senders skip it until it is
   * released, removed, or this process dies.
   */
  spillSync(body: Uint8Array, claimed = false): string | undefined {
    if (!this.ensure()) return undefined
    if (this.sizeBytes() + body.length > this.maxBytes) return undefined
    const name = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}${SUFFIX}${claimed ? `${CLAIM}${process.pid}` : ''}`
    const file = path.join(this.dir, name)
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, body, { mode: 0o600 })
      renameSync(tmp, file)
      return file
    } catch {
      rmSync(tmp, { force: true })
      return undefined
    }
  }

  /** Pending (unclaimed) files, oldest first. */
  pending(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith(SUFFIX)).sort().map((f) => path.join(this.dir, f))
    } catch {
      return []
    }
  }

  /** Atomically claim a file for sending; undefined if another sender got it first. */
  claim(file: string): string | undefined {
    const claimed = `${file}${CLAIM}${process.pid}`
    try {
      renameSync(file, claimed)
      return claimed
    } catch {
      return undefined
    }
  }

  read(claimed: string): Uint8Array | undefined {
    try {
      return readFileSync(claimed)
    } catch {
      return undefined
    }
  }

  release(claimed: string): void {
    try { renameSync(claimed, claimed.slice(0, claimed.lastIndexOf(CLAIM))) } catch { /* already gone */ }
  }

  remove(file: string): void {
    rmSync(file, { force: true })
  }

  /** Release claims held by processes that no longer exist (crashed senders). */
  recoverStaleClaims(): number {
    let recovered = 0
    let entries: string[] = []
    try { entries = readdirSync(this.dir) } catch { return 0 }
    for (const entry of entries) {
      const i = entry.lastIndexOf(CLAIM)
      if (i < 0) continue
      const pid = Number(entry.slice(i + CLAIM.length))
      if (Number.isInteger(pid) && pid !== process.pid && !alive(pid)) {
        this.release(path.join(this.dir, entry))
        recovered++
      }
    }
    return recovered
  }

  /** Files currently claimed by other live processes (e.g. a host's in-flight batch). */
  foreignClaims(): number {
    let count = 0
    let entries: string[] = []
    try { entries = readdirSync(this.dir) } catch { return 0 }
    for (const entry of entries) {
      const i = entry.lastIndexOf(CLAIM)
      if (i < 0) continue
      const pid = Number(entry.slice(i + CLAIM.length))
      if (Number.isInteger(pid) && pid !== process.pid && alive(pid)) count++
    }
    return count
  }

  private sizeBytes(): number {
    let total = 0
    try {
      for (const entry of readdirSync(this.dir)) {
        try { total += statSync(path.join(this.dir, entry)).size } catch { /* raced */ }
      }
    } catch { /* missing dir */ }
    return total
  }
}
