import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionLog, zstdFrames } from '../src/replay.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const header = JSON.stringify({ type: 'session', version: 4, id: 'session-z', createdAt: 1, isSeeded: false }) + '\n'
const event = (seq: number) => JSON.stringify({ type: 'turn/start', seq, time: 10 + seq, data: { turn: seq } }) + '\n'

describe('session log reading', () => {
  it('reads every zstd frame of an appended log, as DSH writes it (one frame per append)', () => {
    const frames = [header, event(1), event(2), event(3)].map((t) => zstdCompressSync(Buffer.from(t)))
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-zstd-'))
    dirs.push(dir)
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.concat(frames))
    expect(zstdFrames(Buffer.concat(frames))).toHaveLength(4)
    expect(readSessionLog(file).events.map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('ignores a torn final frame (a crash mid-write)', () => {
    const whole = [header, event(1)].map((t) => zstdCompressSync(Buffer.from(t)))
    const torn = zstdCompressSync(Buffer.from(event(2)))
    const dir = mkdtempSync(path.join(tmpdir(), 'agentobs-zstd-'))
    dirs.push(dir)
    const file = path.join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.concat([...whole, torn.subarray(0, torn.length - 3)]))
    expect(readSessionLog(file).events.map((e) => e.seq)).toEqual([1])
  })
})
