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
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'

const SUFFIX = '.otlp.gz'
const CLAIM = '.sending-'

/**
 * The outbox holds trace content and is trusted on read: it must be a real directory
 * (not a symlink) owned by this user and closed to others. A directory someone else
 * prepared (e.g. in a shared /tmp) is refused rather than used.
 */
export function ownedPrivateDir(dir: string): boolean {
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory()) return false
    if (typeof process.getuid !== 'function') return true
    if (st.uid !== process.getuid()) return false
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
    return true
  } catch {
    return false
  }
}

/**
 * Owner tag of claims made by this process: `<pid>.<namespace>`. A pid means nothing
 * outside its PID namespace — a relay sidecar sharing the volume sees the host's pids as
 * gone — so claims also name the namespace (the pid-namespace inode on Linux, else the
 * host name). Claims from another namespace are judged by age instead (see ownerAlive).
 */
const NAMESPACE = (() => {
  try {
    const ns = /\[(\d+)\]/.exec(readlinkSync('/proc/self/ns/pid'))?.[1]
    if (ns) return ns
  } catch { /* not Linux */ }
  return hostname().replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'host'
})()
export const OWNER = `${process.pid}.${NAMESPACE}`
/** A claim from another namespace untouched this long is taken as abandoned. */
export const FOREIGN_STALE_MS = 10 * 60_000

/**
 * Whether the owner of a claim may still be working on it. Same namespace: the pid is
 * checked. Another namespace: alive while the file was touched recently (live hosts touch
 * their journals every minute).
 */
export function ownerAlive(tag: string, file: string): boolean {
  const dot = tag.indexOf('.')
  const pid = Number(dot < 0 ? tag : tag.slice(0, dot))
  if (!Number.isInteger(pid)) return false
  const ns = dot < 0 ? undefined : tag.slice(dot + 1)
  // A bare pid comes from builds before namespaced tags (same machine): check the pid.
  if (ns === NAMESPACE || ns === undefined) return pid === process.pid || alive(pid)
  try {
    return Date.now() - statSync(file).mtimeMs < FOREIGN_STALE_MS
  } catch {
    return false
  }
}

/** The owner tag of a claimed file name, or undefined. */
export function claimOwner(entry: string): string | undefined {
  const i = entry.lastIndexOf(CLAIM)
  return i < 0 ? undefined : entry.slice(i + CLAIM.length)
}

export function alive(pid: number): boolean {
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
      return ownedPrivateDir(this.dir)
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
    const name = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}${SUFFIX}${claimed ? `${CLAIM}${OWNER}` : ''}`
    const file = path.join(this.dir, name)
    const tmp = `${file}.tmp`
    try {
      writeFileSync(tmp, body, { mode: 0o600 })
      renameSync(tmp, file)
      return file
    } catch {
      try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
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
    const claimed = `${file}${CLAIM}${OWNER}`
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
    // Never throws (EPERM / EBUSY): a file that cannot be removed is resent at worst.
    try { rmSync(file, { force: true }) } catch { /* best effort */ }
  }

  /** Release claims held by processes that no longer exist (crashed senders). */
  recoverStaleClaims(): number {
    let recovered = 0
    let entries: string[] = []
    try { entries = readdirSync(this.dir) } catch { return 0 }
    for (const entry of entries) {
      const owner = claimOwner(entry)
      if (owner === undefined || owner === OWNER) continue
      const file = path.join(this.dir, entry)
      if (!ownerAlive(owner, file)) {
        this.release(file)
        recovered++
      }
    }
    return recovered
  }

  /** Outbox files currently claimed by other live processes (e.g. a host's in-flight batch). */
  foreignClaims(): number {
    let count = 0
    let entries: string[] = []
    try { entries = readdirSync(this.dir) } catch { return 0 }
    for (const entry of entries) {
      // Only delivery files: a live host's own journal is not ours to wait for.
      if (!entry.includes(`${SUFFIX}${CLAIM}`)) continue
      const owner = claimOwner(entry)
      if (owner !== undefined && owner !== OWNER && ownerAlive(owner, path.join(this.dir, entry))) count++
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
