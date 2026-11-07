/**
 * Live collector: binds DSH Cordis events to per-session tracers.
 *
 * Hooks (all untagged, i.e. global across agent scopes):
 *  - session/created|event|disposed  — durable facts (source of truth)
 *  - agent/assistant-stream          — chat request start, first token, abandonment
 *  - tools/execute                   — exact tool duration + AsyncLocalStorage parent for subagents
 *  - llm/stream                      — auxiliary calls only (purpose set)
 * Never listens to session/flush (a fail-closed checkpoint: a failing listener blocks model requests and tool runs).
 * Every listener is exception-safe: a collector failure must never affect the host.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { AgentLike, AssistantStreamFrame, FinishReason, GenerateOptions, SessionEvent, SessionLike, StreamChunk, TokenUsage, ToolDispatchExecution } from './dsh-types.ts'
import type { Attributes, SpanRecord } from './otlp/types.ts'
import { SessionTracer, type BuilderOptions, type TurnRef } from './trace-builder.ts'

export interface CollectorOptions {
  builder: Omit<BuilderOptions, 'source'>
  includeAuxiliary: boolean
  sampleRatio: number
  emit: (span: SpanRecord) => void
  log: (level: 'debug' | 'warn', message: string) => void
}

interface LiveAttempt {
  attemptId: string
  turn: number
  step: number
  startMs: number
  firstTokenMs?: number
  usage?: TokenUsage
  finish?: FinishReason
}

interface ToolScope {
  sessionId: string
  callId: string
}

/** Minimal Cordis context surface used by the collector. */
export interface ContextLike {
  on(event: string, listener: (...args: any[]) => any): unknown
}

const now = () => Date.now()

function isTokenDelta(chunk: StreamChunk): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== ''
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined
  return false
}

export function sampled(sessionId: string, ratio: number): boolean {
  if (ratio >= 1) return true
  if (ratio <= 0) return false
  const n = createHash('sha256').update(sessionId).digest().readUInt32BE(0)
  return n / 0x1_0000_0000 < ratio
}

export class Collector {
  private tracers = new Map<string, SessionTracer>()
  /** Recently disposed tracers kept for reverse links from parents (bounded). */
  private retired = new Map<string, SessionTracer>()
  private attempts = new Map<string, LiveAttempt>()
  private toolDurations = new Map<string, number>()
  private readonly als = new AsyncLocalStorage<ToolScope>()
  private failures = 0
  private readonly options: CollectorOptions

  constructor(options: CollectorOptions) {
    this.options = options
  }

  attach(ctx: ContextLike): void {
    ctx.on('session/created', (session: SessionLike) => this.guard('session/created', () => this.onCreated(session)))
    ctx.on('session/event', (session: SessionLike, event: SessionEvent) => this.guard('session/event', () => this.onEvent(session, event)))
    ctx.on('session/disposed', (session: SessionLike) => this.guard('session/disposed', () => this.onDisposed(session)))
    ctx.on('agent/assistant-stream', (payload: { agent: AgentLike; frame: AssistantStreamFrame }) =>
      this.guard('agent/assistant-stream', () => this.onFrame(payload.agent, payload.frame)))
    ctx.on('tools/execute', (exec: ToolDispatchExecution, next: () => Promise<unknown>) => this.onToolExecute(exec, next))
    if (this.options.includeAuxiliary) {
      ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => this.onLlmStream(options, next))
    }
  }

  private guard(where: string, fn: () => void): void {
    try {
      fn()
    } catch (error) {
      this.failures++
      if (this.failures <= 20 || this.failures % 1000 === 0) {
        this.options.log('warn', `${where} handler failed (${this.failures}): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      }
    }
  }

  private resolveTurn = (sessionId: string, atMs: number, requireEnded: boolean): TurnRef | undefined =>
    (this.tracers.get(sessionId) ?? this.retired.get(sessionId))?.turnAt(atMs, requireEnded)

  private resolveName = (parentSessionId: string, childSessionId: string): string | undefined =>
    (this.tracers.get(parentSessionId) ?? this.retired.get(parentSessionId))?.childName(childSessionId)

  /** @param beforeSeq - first seq that will be delivered live (seed history stops before it). */
  private tracerFor(session: SessionLike, beforeSeq?: number): SessionTracer | undefined {
    const existing = this.tracers.get(session.id)
    if (existing) return existing
    if (!sampled(session.id, this.options.sampleRatio)) return undefined
    const tracer = new SessionTracer(
      { sessionId: session.id, header: session.header, inheritedEventCount: Number(session.inheritedEventCount ?? 0) },
      { ...this.options.builder, source: 'live' },
      this.options.emit,
      this.resolveTurn,
      this.resolveName,
    )
    this.tracers.set(session.id, tracer)
    this.seed(tracer, session, beforeSeq)
    return tracer
  }

  /**
   * Restored and forked sessions start with events that never pass through
   * `session/event`. Read them once so chat input (full context, then deltas),
   * request config and child names are correct from the first live request.
   */
  private seed(tracer: SessionTracer, session: SessionLike, beforeSeq?: number): void {
    const read = (session as { snapshotEvents?: () => readonly SessionEvent[] }).snapshotEvents
    if (typeof read !== 'function') {
      if (Number(session.firstLifecycleSeq ?? 0) > 0 || Number(session.inheritedEventCount ?? 0) > 0 || (beforeSeq ?? 0) > 0) tracer.markHistoryUnknown()
      return
    }
    try {
      const events = read.call(session)
      tracer.seedHistory(beforeSeq === undefined ? events : events.filter((e) => e.seq < beforeSeq))
    } catch (error) {
      tracer.markHistoryUnknown()
      this.options.log('warn', `could not read history of session ${session.id}: ${String(error)}`)
    }
  }

  private onCreated(session: SessionLike): void {
    const tracer = this.tracerFor(session)
    if (!tracer) return
    const header = session.header
    // Only a freshly created child (new spawn, or new fork whose lifecycle starts at its
    // inherited cut) adopts the calling tool span; resumed sessions keep durable lineage.
    const fresh = Number(session.firstLifecycleSeq) === Number(session.inheritedEventCount)
    const scope = this.als.getStore()
    if (!fresh || !scope || !header.parentSession || scope.sessionId !== header.parentSession) return
    const parentTracer = this.tracers.get(scope.sessionId)
    const ref = parentTracer?.toolSpanRef(scope.callId)
    if (ref) tracer.setParent({ sessionId: scope.sessionId, callId: scope.callId, ...ref })
  }

  private onEvent(session: SessionLike, event: SessionEvent): void {
    const tracer = this.tracerFor(session, Number(event?.seq))
    if (!tracer) return
    const hints: { chatStartMs?: number; chatFirstTokenMs?: number; toolDurationMs?: number } = {}
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const attempt = this.attempts.get(session.id)
      if (attempt && attempt.turn === event.data?.turn && attempt.step === event.data?.step) {
        hints.chatStartMs = attempt.startMs
        if (attempt.firstTokenMs !== undefined) hints.chatFirstTokenMs = attempt.firstTokenMs
      }
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.source?.callId ?? event.data?.message?.toolCallId
      const key = `${session.id}|${String(callId)}`
      const duration = this.toolDurations.get(key)
      if (duration !== undefined) {
        hints.toolDurationMs = duration
        this.toolDurations.delete(key)
      }
    } else if (event.type === 'tool/ptc-dispatch') {
      const key = `${session.id}|${String(event.data?.subCallId)}`
      const duration = this.toolDurations.get(key)
      if (duration !== undefined) {
        hints.toolDurationMs = duration
        this.toolDurations.delete(key)
      }
    }
    tracer.onEvent(event, hints)
  }

  private onDisposed(session: SessionLike): void {
    const tracer = this.tracers.get(session.id)
    this.tracers.delete(session.id)
    this.attempts.delete(session.id)
    for (const key of this.toolDurations.keys()) if (key.startsWith(`${session.id}|`)) this.toolDurations.delete(key)
    if (tracer) {
      this.retired.set(session.id, tracer)
      if (this.retired.size > 256) this.retired.delete(this.retired.keys().next().value!)
    }
  }

  private onFrame(agent: AgentLike, frame: AssistantStreamFrame): void {
    const sessionId = agent?.session?.id
    if (!sessionId) return
    if (frame.type === 'start') {
      this.attempts.set(sessionId, { attemptId: frame.attemptId, turn: frame.turn, step: frame.step, startMs: now() })
      return
    }
    const attempt = this.attempts.get(sessionId)
    if (!attempt || attempt.attemptId !== frame.attemptId) return
    if (frame.type === 'chunk') {
      if (attempt.firstTokenMs === undefined && isTokenDelta(frame.chunk)) attempt.firstTokenMs = frame.time
      if (frame.chunk.type === 'usage') attempt.usage = frame.chunk.usage
      else if (frame.chunk.type === 'finish') attempt.finish = frame.chunk.reason
      return
    }
    if (frame.outcome.kind === 'abandoned') {
      this.tracers.get(sessionId)?.onAbandoned({
        turn: attempt.turn,
        step: attempt.step,
        attemptId: attempt.attemptId,
        startMs: attempt.startMs,
        endMs: now(),
        ...(attempt.firstTokenMs !== undefined ? { firstTokenMs: attempt.firstTokenMs } : {}),
        ...(attempt.usage ? { usage: attempt.usage } : {}),
        ...(attempt.finish ? { finish: attempt.finish } : {}),
      })
    }
    // Keep a committed attempt until the next start: its session/event may be delivered after this frame.
  }

  private onToolExecute(exec: ToolDispatchExecution, next: () => Promise<unknown>): Promise<unknown> {
    const sessionId = exec?.agent?.session?.id
    if (!sessionId) return next()
    const started = performance.now()
    const key = `${sessionId}|${exec.callId}`
    return this.als.run({ sessionId, callId: exec.callId }, async () => {
      try {
        return await next()
      } finally {
        if (this.tracers.has(sessionId)) this.toolDurations.set(key, performance.now() - started)
      }
    })
  }

  private onLlmStream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const purpose = options?.purpose
    const sessionId = options?.sessionId
    if (!purpose || !sessionId) return next()
    const tracer = this.tracers.get(String(sessionId))
    if (!tracer) return next()
    const source = next()
    const self = this
    return (async function* observe() {
      const startMs = now()
      let firstTokenMs: number | undefined
      let usage: TokenUsage | undefined
      let finish: FinishReason | undefined
      try {
        for await (const chunk of source) {
          try {
            if (firstTokenMs === undefined && isTokenDelta(chunk)) firstTokenMs = now()
            if (chunk.type === 'usage') usage = chunk.usage
            else if (chunk.type === 'finish') finish = chunk.reason
          } catch { /* observation only */ }
          yield chunk
        }
      } finally {
        self.guard('llm/stream', () => tracer.onAuxiliary({
          purpose: String(purpose),
          provider: String(options.provider),
          model: String(options.model),
          startMs,
          endMs: now(),
          ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
          ...(usage ? { usage } : {}),
          ...(finish ? { finish } : {}),
        }))
      }
    })()
  }

  get activeSessions(): number {
    return this.tracers.size
  }
}

export function commonAttributes(input: {
  entryType?: string
  entryPlatform?: string
  profile?: string
  userId?: string
  userName?: string
  custom: Record<string, string>
}): Attributes {
  const attrs: Attributes = {
    'gen_ai.agent.type': 'deepseek-harness',
    ...(input.entryType ? { 'gen_ai.entry.type': input.entryType } : {}),
    ...(input.entryPlatform ? { 'gen_ai.entry.platform': input.entryPlatform } : {}),
    ...(input.profile ? { 'agent.custom.dsh_profile': input.profile } : {}),
    ...(input.userId ? { 'gen_ai.user.id': input.userId } : {}),
    ...(input.userName ? { 'gen_ai.user.name': input.userName } : {}),
  }
  for (const [key, value] of Object.entries(input.custom)) attrs[`agent.custom.${key}`] = value
  return attrs
}
