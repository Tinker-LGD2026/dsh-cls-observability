import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { interruptedTail } from '../src/crash-closure.ts'
import type { SessionEvent } from '../src/dsh-types.ts'
import { readSessionLog } from '../src/replay.ts'

/**
 * Cross-check against DSH's own crash repair: cut every recording at every point inside a
 * turn, let DSH's `interruptedTurnClosers` produce the closers, and require the plugin to
 * find exactly where they start. Needs a built `@deepseek-ai/dsh-session` (DSH_SESSION_LIB,
 * or the npm install used by the web e2e).
 */
const root = path.resolve(process.env.DSH_REPO ?? path.join(import.meta.dirname, '../../deepseek-harness'), 'snapshots')
const lib = process.env.DSH_SESSION_LIB ?? path.join(import.meta.dirname, '../.tmp/dsh-npm/node_modules/@deepseek-ai/dsh-session/lib/index.js')
const available = existsSync(root) && existsSync(lib)

describe.skipIf(!available)('crash closer detection vs DSH interruptedTurnClosers', () => {
  it('finds the closers DSH appends at every crash point of every recording', async () => {
    const dsh = await import(lib) as { interruptedTurnClosers: (events: readonly SessionEvent[]) => SessionEvent[] }
    const files: string[] = []
    const walk = (d: string) => { for (const e of readdirSync(d)) { const f = path.join(d, e); if (statSync(f).isDirectory()) walk(f); else if (/^session(\.\d+)?\.v4\.jsonl$/.test(e)) files.push(f) } }
    walk(root)
    let points = 0
    const misses: string[] = []
    for (const file of files) {
      const events = readSessionLog(file).events
      for (let n = 1; n <= events.length; n++) {
        const prefix = events.slice(0, n)
        const closers = dsh.interruptedTurnClosers(prefix)
        if (closers.length === 0) continue
        points++
        // On resume DSH also appends a seed marker after its closers.
        const endSeed = { type: 'session/end-seed', seq: prefix.length + closers.length, time: 0, data: {} } as unknown as SessionEvent
        for (const restored of [[...prefix, ...closers], [...prefix, ...closers, endSeed]]) {
          const tail = interruptedTail(restored)
          if (tail?.closerStart !== n) misses.push(`${path.relative(root, file)}@${n}`)
        }
      }
    }
    expect(points).toBeGreaterThan(5000)
    // Known: a log where DSH already recovered tool calls live, right before the crash,
    // holds results shaped like closers; at worst one tool and one step span repeat.
    expect(misses.every((m) => m.startsWith('sdk/tool-scheduler-recovery/'))).toBe(true)
    expect(misses.length / points).toBeLessThan(0.001)
  }, 60_000)
})
