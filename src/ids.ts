/**
 * Deterministic trace/span ids: the live collector and offline replay compute
 * identical ids from the same Session facts.
 */
import { createHash } from 'node:crypto'

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex')

/** All-zero ids are invalid in OTLP; remap the (astronomically unlikely) zero digest. */
function nonZero(hex: string): string {
  return /^0+$/.test(hex) ? `${hex.slice(0, -1)}1` : hex
}

export function traceIdFor(sessionId: string, turn: number): string {
  return nonZero(sha256(`dsh-trace|${sessionId}|t${turn}`).slice(0, 32))
}

export function spanIdFor(sessionId: string, path: string): string {
  return nonZero(sha256(`dsh-span|${sessionId}|${path}`).slice(0, 16))
}

export const paths = {
  entry: (turn: number) => `t${turn}:entry`,
  agent: (turn: number) => `t${turn}:agent`,
  step: (turn: number, step: number) => `t${turn}:s${step}`,
  chat: (turn: number, step: number, seq: number) => `t${turn}:s${step}:c${seq}`,
  orphanChat: (turn: number, step: number, attemptId: string) => `t${turn}:s${step}:orphan:${attemptId}`,
  tool: (turn: number, step: number, callId: string) => `t${turn}:s${step}:tool:${callId}`,
  aux: (turn: number, purpose: string, n: number) => `t${turn}:aux:${purpose}:${n}`,
} as const

/** Stable short hash for `gen_ai.input.messages.hash` (32 hex chars). */
export function contentHash(value: unknown): string {
  return sha256(JSON.stringify(value)).slice(0, 32)
}
