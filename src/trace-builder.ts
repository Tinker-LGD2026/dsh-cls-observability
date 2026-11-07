/**
 * Session → AgentObs span builder. Pure logic, shared by the live collector
 * and offline replay: feed Session events in log order (plus optional live
 * timing hints) and it emits entry/agent/step/chat/tool spans with
 * deterministic ids.
 */
import type { AssistantStreamRecord, FinishReason, LlmCallConfig, Message, SessionEvent, SessionHeader, TokenUsage } from './dsh-types.ts'
import { contentHash, paths, spanIdFor, traceIdFor } from './ids.ts'
import { SpanKind, StatusCode, double, type Attributes, type SpanEvent, type SpanLink, type SpanRecord } from './otlp/types.ts'
import { Truncator, contentText, finishReasonName, messageToGenAi, readStream, usageAttributes } from './semconv.ts'

export interface BuilderOptions {
  captureContent: boolean
  maxContentChars: number
  /** Static attributes added to every span (agent.type, entry.*, user.*, agent.custom.*). */
  commonAttributes: Attributes
  source: 'live' | 'replay'
}

export interface LiveHints {
  /** Request start (ms) of the attempt that settled with this event (from `agent/assistant-stream` start). */
  chatStartMs?: number
  /** First token time observed live; fallback when the durable stream carries none. */
  chatFirstTokenMs?: number
  /** Exact `tools/execute` duration (ms) for the call settled by this event. */
  toolDurationMs?: number
}

/** Parent tool span of a freshly created subagent. */
export interface ParentToolRef {
  sessionId: string
  traceId: string
  spanId: string
  callId: string
}

export interface TurnRef {
  turn: number
  traceId: string
  agentSpanId: string
  startMs: number
  endMs?: number
}

export interface AuxiliaryCall {
  purpose: string
  provider: string
  model: string
  startMs: number
  endMs: number
  firstTokenMs?: number
  usage?: TokenUsage
  finish?: FinishReason
}

export interface AbandonedAttempt {
  turn: number
  step: number
  attemptId: string
  startMs: number
  endMs: number
  firstTokenMs?: number
  usage?: TokenUsage
  finish?: FinishReason
}

/** Resolves another session's turns for reverse links (subagent results, agent messages). */
export type TurnResolver = (sessionId: string, atMs: number, requireEnded: boolean) => TurnRef | undefined

/** Resolves a subagent's name from its parent's `subagent/catalog` (parentSessionId, childSessionId). */
export type NameResolver = (parentSessionId: string, childSessionId: string) => string | undefined

interface SurfaceNode {
  seq: number
  message: Message
  /** Hash of the raw (untruncated) role + content, computed once. */
  hash: string
}

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

interface TurnState {
  turn: number
  traceId: string
  entryId: string
  agentId: string
  entryParentId?: string
  startMs: number
  messageCount: number
  toolCallCount: number
  stepOneSources: { kind: string; form?: string }[]
  firstUserMessages: Message[]
  /** Step-1 messages that started the turn when no direct user prompt did (subagent result, goal round, …). */
  triggerMessages: Message[]
  lastAssistant?: Message
  /** Hash of the system prompt + tool definitions last attached to a chat span in this turn. */
  chatContextHash?: string
  events: SpanEvent[]
  entryLinks: SpanLink[]
  auxCount: number
  contentTruncated: boolean
}

interface StepState {
  turn: number
  step: number
  spanId: string
  startMs: number
  /** Latest request-preceding event time since the previous settlement (replay TTFT baseline). */
  baselineMs: number
  chatCount: number
  lastChatId?: string
  lastFinish?: string
  lastChatFailed: boolean
  pendingChatEvents: SpanEvent[]
  links: SpanLink[]
}

interface ToolState {
  callId: string
  rootCallId: string
  turn: number
  step: number
  name: string
  argumentsRaw: unknown
  startMs: number
  spanId: string
  parentSpanId: string
  traceId: string
  nested: boolean
  admissionDecidedMs?: number
  admissionOutcome?: string
  admissionWaitMs?: number
  escalationWaitMs: number
  escalationOutcome?: string
  events: SpanEvent[]
}

interface ApprovalState {
  callId?: string
  askedMs: number
  escalation: boolean
}

const CONTEXT_FORMS = new Set(['instructions', 'catalog', 'snapshot', 'recall'])
/** Injected context, never the reason a turn started. */
const CONTEXT_KINDS = new Set(['runtime-context', 'time-context', 'compact-checkpoint', 'skill-catalog', 'agent-instructions'])
const TRIGGER_KINDS = new Set(['user', 'schedule', 'subagent-settled', 'agent-message', 'team-message', 'tool-goal', 'goal-round'])
const AGENT_SPAN_EVENTS = new Set([
  'compaction/start', 'compaction/end', 'compaction/prune', 'sandbox/mode', 'model/selection', 'plan/mode', 'team/mode',
  'approval/policy', 'permission/preset', 'goal/change', 'working-directory/change',
])
const MAX_TURN_REFS = 64

const ns = (ms: number): bigint => BigInt(Math.round(ms)) * 1_000_000n
const ms = (value: number): number => Math.max(0, Math.round(value))

function scalarAttributes(data: unknown, limit = 128): Attributes {
  const out: Attributes = {}
  if (typeof data !== 'object' || data === null) return out
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string' && value.length <= limit) out[key] = value
  }
  return out
}

function outcomeName(outcome: unknown): string {
  if (typeof outcome === 'string') return outcome
  if (outcome && typeof outcome === 'object' && 'kind' in outcome) return String((outcome as { kind: unknown }).kind)
  return 'unknown'
}

/** Normalize a provider route (e.g. `deepseek-official`) to a GenAI system name. */
export function systemName(provider: string | undefined): string | undefined {
  if (!provider) return undefined
  const p = provider.toLowerCase()
  for (const known of ['deepseek', 'anthropic', 'openai', 'gemini', 'google', 'azure', 'bedrock', 'mistral', 'moonshot', 'qwen', 'zhipu']) {
    if (p.includes(known)) return known
  }
  return provider
}

export class SessionTracer {
  readonly sessionId: string
  private readonly header: SessionHeader
  private readonly skipBeforeSeq: number
  private parent?: ParentToolRef
  private parentConsumed = false

  private turns = new Map<number, TurnState>()
  private steps = new Map<string, StepState>()
  private tools = new Map<string, ToolState>()
  private approvals = new Map<string, ApprovalState>()
  /** Mirror of the session's model-visible surface, in order. */
  private surface: SurfaceNode[] = []
  /** Surface node seqs already reported as chat input (delta cursor). */
  private reportedSeqs?: number[]
  private historyUnknown = false
  private catalog = new Map<string, string>()
  private config?: LlmCallConfig
  private contextWindow?: number
  private toolDefinitions?: unknown[]
  private openTurn?: number
  private turnRefs: TurnRef[] = []
  private standaloneAux = 0

  private readonly options: BuilderOptions
  private readonly emit: (span: SpanRecord) => void
  private readonly resolveTurn?: TurnResolver
  private readonly resolveName?: NameResolver

  constructor(
    meta: { sessionId: string; header: SessionHeader; inheritedEventCount: number },
    options: BuilderOptions,
    emit: (span: SpanRecord) => void,
    resolveTurn?: TurnResolver,
    resolveName?: NameResolver,
  ) {
    this.options = options
    this.emit = emit
    if (resolveTurn) this.resolveTurn = resolveTurn
    if (resolveName) this.resolveName = resolveName
    this.sessionId = meta.sessionId
    this.header = meta.header
    this.skipBeforeSeq = meta.inheritedEventCount
  }

  /** Attach the parent tool span of a freshly created subagent (first turn joins the parent trace). */
  setParent(parent: ParentToolRef): void {
    this.parent = parent
  }

  get parentRef(): ParentToolRef | undefined {
    return this.parent
  }

  /** Locate one of this session's turns for a reverse link. */
  turnAt(atMs: number, requireEnded: boolean): TurnRef | undefined {
    for (let i = this.turnRefs.length - 1; i >= 0; i--) {
      const ref = this.turnRefs[i]!
      if (requireEnded) {
        if (ref.endMs !== undefined && ref.endMs <= atMs) return ref
      } else if (ref.startMs <= atMs) return ref
    }
    return undefined
  }

  /** Current open turn's span refs, used to parent tool-spawned subagents and auxiliary calls. */
  toolSpanRef(callId: string): { traceId: string; spanId: string } | undefined {
    const tool = this.tools.get(callId)
    return tool ? { traceId: tool.traceId, spanId: tool.spanId } : undefined
  }

  /** Name of a direct child recorded in this session's `subagent/catalog`. */
  childName(childId: string): string | undefined {
    return this.catalog.get(childId)
  }

  /**
   * Feed events that existed before this tracer attached (restored or fork-inherited
   * history). They only rebuild state — model-visible surface, request config, child
   * names — and never produce spans.
   */
  seedHistory(events: readonly SessionEvent[]): void {
    for (const event of events) {
      this.observeState(event)
      this.applySurface(event)
    }
  }

  /** History is known to be incomplete (could not be read): the next full report is partial. */
  markHistoryUnknown(): void {
    this.historyUnknown = true
  }

  onEvent(event: SessionEvent, hints: LiveHints = {}): void {
    this.observeState(event)
    if (event.seq < this.skipBeforeSeq) {
      this.applySurface(event)
      return
    }
    try {
      this.onSpanEvent(event, hints)
    } finally {
      // After span logic: a chat's input is the surface *before* its own assistant message.
      this.applySurface(event)
    }
  }

  /** Non-span state that later spans read. Runs for every event, including inherited ones. */
  private observeState(event: SessionEvent): void {
    const data = event.data ?? {}
    switch (event.type) {
      case 'request/header':
        if (data.header?.config) this.config = data.header.config
        if (Array.isArray(data.header?.tools)) this.toolDefinitions = data.header.tools
        break
      case 'request/context':
        if (typeof data.contextWindow === 'number') this.contextWindow = data.contextWindow
        break
      case 'subagent/catalog':
        if (typeof data.childId === 'string' && typeof data.name === 'string' && data.name) this.catalog.set(data.childId, data.name)
        break
    }
  }

  /** Mirror the session's ordered model-visible surface (append / replace ops). */
  private applySurface(event: SessionEvent): void {
    const op = event.surfaceOp as undefined | 'append' | { op?: string; startSeq?: number; endSeq?: number }
    if (op === undefined || !SURFACE_TYPES.has(event.type)) return
    const message = (event.type === 'user/message' ? event.data : event.data?.message) as Message | undefined
    if (!message || !Array.isArray(message.content)) return
    const node: SurfaceNode = { seq: event.seq, message, hash: contentHash([message.role, message.content]) }
    if (op === 'append') {
      this.surface.push(node)
      return
    }
    const start = this.surface.findIndex((n) => n.seq === op.startSeq)
    const end = this.surface.findIndex((n) => n.seq === op.endSeq)
    if (op.op === 'replace' && start >= 0 && end >= start) {
      this.surface.splice(start, end - start + 1, node)
    } else {
      // Replaced nodes we never saw: the mirrored surface can no longer be trusted as complete.
      this.historyUnknown = true
      this.surface.push(node)
    }
  }

  private onSpanEvent(event: SessionEvent, hints: LiveHints): void {
    switch (event.type) {
      case 'turn/start': return this.onTurnStart(event)
      case 'turn/end': return this.onTurnEnd(event)
      case 'step/start': return this.onStepStart(event)
      case 'step/end': return this.onStepEnd(event)
      case 'user/message': return this.onUserMessage(event)
      case 'system/message':
      case 'developer/message':
      case 'request/header':
      case 'request/context':
      case 'llm/retry-started':
        return this.touchBaseline(event)
      case 'llm/retry': return this.onRetry(event)
      case 'assistant/message':
      case 'assistant/attempt':
        return this.onAssistant(event, hints)
      case 'tool/call': return this.onToolCall(event)
      case 'tool/result': return this.onToolResult(event, hints)
      case 'tool/ptc-dispatch-start': return this.onPtcStart(event)
      case 'tool/ptc-dispatch': return this.onPtcEnd(event, hints)
      case 'approval/asked': return this.onApprovalAsked(event)
      case 'approval/decided': return this.onApprovalDecided(event)
      default:
        if (event.type === 'compaction/end') this.touchBaseline(event)
        if (AGENT_SPAN_EVENTS.has(event.type)) this.addTurnEvent(event.type, event.time, scalarAttributes(event.data ?? {}))
    }
  }

  // ---------------------------------------------------------------- turns

  private onTurnStart(event: SessionEvent): void {
    const turn = Number(event.data.turn)
    let traceId = traceIdFor(this.sessionId, turn)
    let entryParentId: string | undefined
    const entryLinks: SpanLink[] = []
    if (this.parent && !this.parentConsumed) {
      traceId = this.parent.traceId
      entryParentId = this.parent.spanId
      this.parentConsumed = true
    } else if (this.parent) {
      entryLinks.push({ traceId: this.parent.traceId, spanId: this.parent.spanId, attributes: { 'agent.custom.link_type': 'parent_tool_call' } })
    }
    const state: TurnState = {
      turn,
      traceId,
      entryId: spanIdFor(this.sessionId, paths.entry(turn)),
      agentId: spanIdFor(this.sessionId, paths.agent(turn)),
      ...(entryParentId ? { entryParentId } : {}),
      startMs: event.time,
      messageCount: 0,
      toolCallCount: 0,
      stepOneSources: [],
      firstUserMessages: [],
      triggerMessages: [],
      events: [],
      entryLinks,
      auxCount: 0,
      contentTruncated: false,
    }
    this.turns.set(turn, state)
    this.openTurn = turn
    this.turnRefs.push({ turn, traceId, agentSpanId: state.agentId, startMs: event.time })
    if (this.turnRefs.length > MAX_TURN_REFS) this.turnRefs.shift()
  }

  private onTurnEnd(event: SessionEvent): void {
    const turn = Number(event.data.turn)
    const state = this.turns.get(turn)
    if (!state) return
    this.turns.delete(turn)
    if (this.openTurn === turn) this.openTurn = undefined
    for (const key of [...this.steps.keys()]) if (key.startsWith(`${turn}:`)) this.steps.delete(key)
    const ref = this.turnRefs.find((r) => r.turn === turn && r.endMs === undefined)
    if (ref) ref.endMs = event.time

    const reason = (event.data.reason ?? { kind: 'completed' }) as { kind: string; error?: { message?: string; code?: string } }
    if (reason.kind === 'forked') return
    const failed = reason.kind === 'error' || reason.kind === 'interrupted'
    const status = failed
      ? { code: StatusCode.Error, message: reason.kind === 'error' ? String(reason.error?.code ?? 'error') : 'interrupted' }
      : { code: StatusCode.Ok }
    const trigger = this.triggerOf(state)
    const t = new Truncator(this.options.maxContentChars)
    const content: Attributes = {}
    if (this.options.captureContent) {
      // Turn-level I/O (CLS AgentObs entry/agent fields): the prompt that started the turn, and the final answer,
      // i.e. the output of the last committed model chat without its reasoning.
      const inputs = state.firstUserMessages.length > 0 ? state.firstUserMessages : state.triggerMessages
      if (inputs.length > 0) content['gen_ai.input.messages'] = inputs.map((m) => messageToGenAi(m, t))
      if (state.lastAssistant) {
        const answer = { ...state.lastAssistant, content: state.lastAssistant.content.filter((b) => b.type !== 'reasoning') }
        content['gen_ai.output.messages'] = [messageToGenAi(answer.content.length > 0 ? answer : state.lastAssistant, t)]
      }
    }
    const subagent = this.header.origin === 'subagent'
    const truncated = t.truncated || state.contentTruncated ? { 'agent.custom.content_truncated': true } : {}
    const turnAttrs: Attributes = {
      ...this.common(turn),
      'agent.custom.turn_end_reason': reason.kind,
      'agent.custom.trigger': trigger,
      ...(reason.kind === 'error' && reason.error?.code ? { 'error.type': String(reason.error.code) } : {}),
      ...truncated,
    }

    this.emit({
      traceId: state.traceId,
      spanId: state.agentId,
      parentSpanId: state.entryId,
      name: `${subagent ? 'invoke_subagent' : 'invoke_agent'} ${this.agentName()}`,
      kind: SpanKind.Internal,
      startNs: ns(state.startMs),
      endNs: ns(event.time),
      attributes: {
        ...turnAttrs,
        ...content,
        'gen_ai.span.kind': 'agent',
        'gen_ai.operation.name': subagent ? 'invoke_subagent' : 'invoke_agent',
        'gen_ai.agent.message_count': state.messageCount,
        'gen_ai.agent.tool_call_count': state.toolCallCount,
      },
      status,
      ...(state.events.length > 0 ? { events: state.events } : {}),
    })
    this.emit({
      traceId: state.traceId,
      spanId: state.entryId,
      ...(state.entryParentId ? { parentSpanId: state.entryParentId } : {}),
      name: 'enter_application',
      kind: SpanKind.Server,
      startNs: ns(state.startMs),
      endNs: ns(event.time),
      attributes: { ...turnAttrs, ...content, 'gen_ai.span.kind': 'entry', 'gen_ai.operation.name': 'enter_application' },
      status,
      ...(state.entryLinks.length > 0 ? { links: state.entryLinks } : {}),
    })
  }

  private triggerOf(state: TurnState): string {
    const sources = state.stepOneSources
    const direct = sources.find((s) => s.form === undefined)
    if (direct) return direct.kind
    const known = sources.find((s) => TRIGGER_KINDS.has(s.kind))
    if (known) return known.kind
    const nonContext = sources.find((s) => s.kind !== 'runtime-context' && !CONTEXT_FORMS.has(s.form ?? ''))
    return nonContext?.kind ?? 'unknown'
  }

  private addTurnEvent(name: string, timeMs: number, attributes: Attributes): void {
    const state = this.openTurn !== undefined ? this.turns.get(this.openTurn) : undefined
    state?.events.push({ timeNs: ns(timeMs), name, attributes })
  }

  // ---------------------------------------------------------------- steps

  private stepKey(turn: number, step: number): string {
    return `${turn}:${step}`
  }

  private onStepStart(event: SessionEvent): void {
    const turn = Number(event.data.turn)
    const step = Number(event.data.step)
    if (!this.turns.has(turn)) return
    this.steps.set(this.stepKey(turn, step), {
      turn,
      step,
      spanId: spanIdFor(this.sessionId, paths.step(turn, step)),
      startMs: event.time,
      baselineMs: event.time,
      chatCount: 0,
      lastChatFailed: false,
      pendingChatEvents: [],
      links: [],
    })
  }

  private currentStep(): StepState | undefined {
    if (this.openTurn === undefined) return undefined
    let latest: StepState | undefined
    for (const s of this.steps.values()) if (s.turn === this.openTurn && (!latest || s.step > latest.step)) latest = s
    return latest
  }

  private touchBaseline(event: SessionEvent): void {
    const step = this.currentStep()
    if (step) step.baselineMs = event.time
  }

  private onStepEnd(event: SessionEvent): void {
    const turn = Number(event.data.turn)
    const stepNo = Number(event.data.step)
    const key = this.stepKey(turn, stepNo)
    const step = this.steps.get(key)
    const turnState = this.turns.get(turn)
    if (!step || !turnState) return
    this.steps.delete(key)
    this.emit({
      traceId: turnState.traceId,
      spanId: step.spanId,
      parentSpanId: turnState.agentId,
      name: `react round_${stepNo}`,
      kind: SpanKind.Internal,
      startNs: ns(step.startMs),
      endNs: ns(event.time),
      attributes: {
        ...this.common(turn, stepNo),
        'gen_ai.span.kind': 'step',
        'gen_ai.operation.name': 'react',
        'gen_ai.react.round': stepNo,
        ...(step.lastFinish ? { 'gen_ai.react.finish_reason': step.lastFinish } : {}),
      },
      status: step.lastChatFailed ? { code: StatusCode.Error, message: step.lastFinish ?? 'error' } : { code: StatusCode.Ok },
      ...(step.links.length > 0 ? { links: step.links } : {}),
    })
  }

  // ---------------------------------------------------------------- messages

  private onUserMessage(event: SessionEvent): void {
    const message = event.data as Message
    const turn = this.openTurn !== undefined ? this.turns.get(this.openTurn) : undefined
    const step = this.currentStep()
    this.touchBaseline(event)
    if (!turn) return
    turn.messageCount++
    const source = message.source ?? { kind: 'unknown' }
    if (step?.step === 1) {
      turn.stepOneSources.push({ kind: String(source.kind), ...(typeof source.form === 'string' ? { form: source.form } : {}) })
      if (source.kind === 'user') turn.firstUserMessages.push(message)
      else if (!CONTEXT_KINDS.has(String(source.kind)) && !CONTEXT_FORMS.has(String(source.form ?? ''))) turn.triggerMessages.push(message)
    }
    this.linkSender(message, step, turn, event.time)
  }

  private linkSender(message: Message, step: StepState | undefined, turn: TurnState, atMs: number): void {
    const kind = message.source?.kind
    const sender = message.source?.senderSessionId
    if ((kind !== 'subagent-settled' && kind !== 'agent-message') || typeof sender !== 'string' || !this.resolveTurn) return
    const ref = this.resolveTurn(sender, atMs, kind === 'subagent-settled')
    if (!ref) return
    const link: SpanLink = {
      traceId: ref.traceId,
      spanId: ref.agentSpanId,
      attributes: { 'agent.custom.link_type': kind, 'agent.custom.sender_session_id': sender },
    }
    step?.links.push(link)
    if (step?.step === 1) turn.entryLinks.push(link)
  }

  // ---------------------------------------------------------------- chat

  private onRetry(event: SessionEvent): void {
    const data = event.data
    const step = this.steps.get(this.stepKey(Number(data.turn), Number(data.step)))
    step?.pendingChatEvents.push({
      timeNs: ns(event.time),
      name: 'retry',
      attributes: {
        'agent.custom.retry': Number(data.retry ?? 0),
        ...(typeof data.maxRetries === 'number' ? { 'agent.custom.max_retries': data.maxRetries } : {}),
        ...(typeof data.delayMs === 'number' ? { 'agent.custom.delay_ms': data.delayMs } : {}),
        ...(data.failure?.code ? { 'error.type': String(data.failure.code) } : {}),
        ...(typeof data.failure?.status === 'number' ? { 'agent.custom.http_status': data.failure.status } : {}),
      },
    })
  }

  private onAssistant(event: SessionEvent, hints: LiveHints): void {
    const data = event.data as { turn: number; step: number; message?: Message; stream?: AssistantStreamRecord[]; usage?: TokenUsage; interrupted?: true }
    const turnState = this.turns.get(Number(data.turn))
    const step = this.steps.get(this.stepKey(Number(data.turn), Number(data.step)))
    if (!turnState || !step) return
    const facts = readStream(data.stream)
    if (facts.firstTokenTime === undefined && hints.chatFirstTokenMs !== undefined) facts.firstTokenTime = hints.chatFirstTokenMs
    const approxStart = hints.chatStartMs === undefined
    const startMs = Math.min(hints.chatStartMs ?? step.baselineMs, event.time)
    const isMessage = event.type === 'assistant/message'
    const span = this.chatSpan({
      traceId: turnState.traceId,
      parentSpanId: step.spanId,
      spanId: spanIdFor(this.sessionId, paths.chat(step.turn, step.step, event.seq)),
      turn: step.turn,
      step: step.step,
      startMs,
      endMs: event.time,
      ...(facts.firstTokenTime !== undefined ? { firstTokenMs: facts.firstTokenTime } : {}),
      ...(facts.finishTime !== undefined ? { finishMs: facts.finishTime } : {}),
      ttftApprox: approxStart,
      usage: data.usage ?? facts.usage,
      finish: facts.finish,
      interrupted: data.interrupted === true,
      output: isMessage ? data.message : undefined,
      inputAttrs: this.chatInputAttributes(),
      replayable: true,
      events: step.pendingChatEvents.splice(0),
      retryOf: step.lastChatId,
      retryIndex: step.chatCount,
    })
    this.emit(span)
    step.chatCount++
    step.lastChatId = span.spanId
    step.lastFinish = facts.finish ? finishReasonName(facts.finish.kind) : (data.interrupted ? 'interrupted' : undefined)
    step.lastChatFailed = span.status?.code === StatusCode.Error
    step.baselineMs = event.time
    if (isMessage) {
      turnState.messageCount++
      if (data.message) turnState.lastAssistant = data.message
    }
  }

  /** Live-only: an attempt that started streaming but committed no durable settlement. */
  onAbandoned(attempt: AbandonedAttempt): void {
    const turnState = this.turns.get(attempt.turn)
    const step = this.steps.get(this.stepKey(attempt.turn, attempt.step))
    if (!turnState || !step) return
    this.emit(this.chatSpan({
      traceId: turnState.traceId,
      parentSpanId: step.spanId,
      spanId: spanIdFor(this.sessionId, paths.orphanChat(attempt.turn, attempt.step, attempt.attemptId)),
      turn: attempt.turn,
      step: attempt.step,
      startMs: attempt.startMs,
      endMs: attempt.endMs,
      ...(attempt.firstTokenMs !== undefined ? { firstTokenMs: attempt.firstTokenMs } : {}),
      ttftApprox: false,
      usage: attempt.usage,
      finish: attempt.finish,
      interrupted: false,
      abandoned: true,
      inputAttrs: this.chatInputAttributes(),
      replayable: false,
      events: [],
      retryOf: step.lastChatId,
      retryIndex: step.chatCount,
    }))
  }

  /** Auxiliary model call (compaction, session title, auto review), observed via `llm/stream`. */
  onAuxiliary(call: AuxiliaryCall): void {
    const turnState = this.openTurn !== undefined ? this.turns.get(this.openTurn) : undefined
    if (turnState) {
      this.emit(this.chatSpan({
        traceId: turnState.traceId,
        parentSpanId: turnState.agentId,
        spanId: spanIdFor(this.sessionId, paths.aux(turnState.turn, call.purpose, ++turnState.auxCount)),
        turn: turnState.turn,
        startMs: call.startMs,
        endMs: call.endMs,
        ...(call.firstTokenMs !== undefined ? { firstTokenMs: call.firstTokenMs } : {}),
        ttftApprox: false,
        usage: call.usage,
        finish: call.finish,
        interrupted: false,
        replayable: false,
        events: [],
        purpose: call.purpose,
        provider: call.provider,
        model: call.model,
      }))
      return
    }
    const n = ++this.standaloneAux
    const last = this.turnRefs.at(-1)
    const turn = last?.turn ?? 0
    const traceId = traceIdFor(this.sessionId, -n)
    this.emit(this.chatSpan({
      traceId,
      spanId: spanIdFor(this.sessionId, `aux:${call.purpose}:${n}`),
      turn,
      startMs: call.startMs,
      endMs: call.endMs,
      ...(call.firstTokenMs !== undefined ? { firstTokenMs: call.firstTokenMs } : {}),
      ttftApprox: false,
      usage: call.usage,
      finish: call.finish,
      interrupted: false,
      replayable: false,
      events: [],
      purpose: call.purpose,
      provider: call.provider,
      model: call.model,
      links: last ? [{ traceId: last.traceId, spanId: last.agentSpanId, attributes: { 'agent.custom.link_type': 'auxiliary_after_turn' } }] : [],
    }))
  }

  private chatSpan(input: {
    traceId: string
    parentSpanId?: string
    spanId: string
    turn: number
    step?: number
    startMs: number
    endMs: number
    firstTokenMs?: number
    finishMs?: number
    ttftApprox: boolean
    usage?: TokenUsage
    finish?: FinishReason
    interrupted: boolean
    abandoned?: boolean
    output?: Message
    inputAttrs?: Attributes
    replayable: boolean
    events: SpanEvent[]
    retryOf?: string
    retryIndex?: number
    purpose?: string
    provider?: string
    model?: string
    links?: SpanLink[]
  }): SpanRecord {
    const provider = input.provider ?? this.config?.provider
    const model = input.model ?? this.config?.model
    const finishKind = input.finish?.kind
    const failed = input.abandoned || input.interrupted || finishKind === 'error' || finishKind === 'aborted'
    const end = input.finishMs ?? input.endMs
    const attrs: Attributes = {
      ...this.common(input.turn, input.step),
      'gen_ai.span.kind': 'chat',
      'gen_ai.operation.name': 'chat',
      ...(provider ? { 'gen_ai.provider.name': systemName(provider), 'agent.custom.provider_route': provider } : {}),
      ...(model ? { 'gen_ai.request.model': model, 'gen_ai.response.model': model } : {}),
      ...(finishKind ? { 'gen_ai.response.finish_reasons': [finishReasonName(finishKind)] } : {}),
      'gen_ai.chat.duration_ms': ms(end - input.startMs),
      ...(input.firstTokenMs !== undefined ? { 'gen_ai.response.time_to_first_token_ms': ms(input.firstTokenMs - input.startMs) } : {}),
      ...(input.ttftApprox && this.options.source === 'replay' ? { 'agent.custom.ttft_approx': true } : {}),
      ...usageAttributes(input.usage),
      ...(input.purpose ? {} : this.requestAttributes()),
      ...(input.purpose ? { 'agent.custom.llm_purpose': input.purpose } : {}),
      ...(input.retryOf && input.retryIndex ? { 'agent.custom.retry_of': input.retryOf, 'agent.custom.retry_index': input.retryIndex } : {}),
      ...(input.replayable ? {} : { 'agent.custom.replayable': false }),
      ...(finishKind === 'error' || finishKind === 'aborted'
        ? { 'error.type': String(input.finish?.failure?.code ?? finishKind) }
        : {}),
    }
    if (!input.purpose) this.addChatContent(attrs, input.output, input.inputAttrs)
    return {
      traceId: input.traceId,
      spanId: input.spanId,
      ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
      name: `chat ${model ?? 'unknown'}`,
      kind: SpanKind.Client,
      startNs: ns(input.startMs),
      endNs: ns(Math.max(input.endMs, input.startMs)),
      attributes: attrs,
      status: failed
        ? { code: StatusCode.Error, message: input.abandoned ? 'abandoned' : input.interrupted ? 'interrupted' : String(input.finish?.failure?.code ?? finishKind) }
        : { code: StatusCode.Ok },
      ...(input.events.length > 0 ? { events: input.events } : {}),
      ...(input.links && input.links.length > 0 ? { links: input.links } : {}),
    }
  }

  private requestAttributes(): Attributes {
    const c = this.config
    if (!c) return {}
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const temperature = num(c.temperature)
    const topP = num(c.topP ?? (c as Record<string, unknown>).top_p)
    const maxTokens = num(c.maxTokens)
    const seed = num(c.seed)
    return {
      ...(temperature !== undefined ? { 'gen_ai.request.temperature': double(temperature) } : {}),
      ...(topP !== undefined ? { 'gen_ai.request.top_p': double(topP) } : {}),
      ...(maxTokens !== undefined ? { 'gen_ai.request.max_tokens': Math.round(maxTokens) } : {}),
      ...(seed !== undefined ? { 'gen_ai.request.seed': Math.round(seed) } : {}),
      ...(Array.isArray(c.stop) && c.stop.length > 0 ? { 'gen_ai.request.stop_sequences': c.stop.map(String) } : {}),
      ...(typeof c.reasoningEffort === 'string' ? { 'agent.custom.reasoning_effort': c.reasoningEffort } : {}),
      ...(this.contextWindow !== undefined ? { 'agent.custom.context_window': this.contextWindow } : {}),
    }
  }

  /** Model-visible surface nodes (dormant empty nodes skipped). */
  private visibleSurface(): SurfaceNode[] {
    return this.surface.filter((n) => n.message.content.length > 0 && !(n.message.role === 'system' && contentText(n.message.content) === ''))
  }

  /** Effective system prompt: the latest non-empty system node on the surface. */
  private systemText(): string | undefined {
    for (let i = this.surface.length - 1; i >= 0; i--) {
      const m = this.surface[i]!.message
      if (m.role === 'system') {
        const text = contentText(m.content)
        if (text) return text
      }
    }
    return undefined
  }

  /**
   * Chat input per the CLS AgentObs chat fields: the session's request context is
   * DSH's append-only surface, so after the first full report each chat carries only
   * the messages added since the previous chat (`gen_ai.input.messages_delta`). A
   * rewritten prefix (compaction, unknown history) falls back to a full report.
   * `gen_ai.input.messages.hash` always covers the full, untruncated context. The system
   * prompt and tool updates travel in `system_instructions` / `tool.definitions`.
   * Advances the delta cursor; call once per model request.
   */
  private chatInputAttributes(): Attributes {
    const visible = this.visibleSurface()
    const conversation = visible.filter((n) => n.message.role !== 'system' && n.message.role !== 'developer')
    const attrs: Attributes = {
      'gen_ai.input.messages.hash': contentHash(visible.map((n) => n.hash)),
      'agent.custom.input_message_count': conversation.length,
    }
    const seqs = conversation.map((n) => n.seq)
    const previous = this.reportedSeqs
    let reset: string | undefined
    if (previous === undefined) reset = this.historyUnknown ? 'history_unknown' : 'first_report'
    else if (previous.length > seqs.length) reset = 'context_shrank'
    else if (previous.some((seq, i) => seqs[i] !== seq)) reset = 'prefix_changed'
    this.reportedSeqs = seqs
    if (!this.options.captureContent) return attrs

    const t = new Truncator(this.options.maxContentChars)
    if (reset === undefined) {
      attrs['gen_ai.input.messages_delta'] = conversation.slice(previous!.length).map((n) => messageToGenAi(n.message, t))
    } else {
      // Bound one full report; keep the most recent messages when the history is very long.
      const budget = this.options.maxContentChars * 8
      let used = 0
      let from = conversation.length
      while (from > 0) {
        const size = JSON.stringify(conversation[from - 1]!.message.content).length
        if (used + size > budget && from < conversation.length) break
        used += size
        from--
      }
      attrs['gen_ai.input.messages'] = conversation.slice(from).map((n) => messageToGenAi(n.message, t))
      if (from > 0) attrs['agent.custom.input_messages_omitted'] = from
      if (reset !== 'first_report') attrs['agent.custom.input_delta_reset'] = reset
      if (this.historyUnknown) attrs['agent.custom.input_context_partial'] = true
    }
    if (t.truncated) attrs['agent.custom.content_truncated'] = true
    return attrs
  }

  private addChatContent(attrs: Attributes, output: Message | undefined, inputAttrs: Attributes | undefined): void {
    if (inputAttrs) Object.assign(attrs, inputAttrs)
    if (!this.options.captureContent) return
    const t = new Truncator(this.options.maxContentChars)
    if (output) attrs['gen_ai.output.messages'] = [messageToGenAi(output, t)]
    // The system prompt and tool list are large and rarely change: attach them to the first
    // chat of each turn and again only when they change, not to every chat span.
    const turnState = this.openTurn !== undefined ? this.turns.get(this.openTurn) : undefined
    const systemText = this.systemText()
    const contextHash = contentHash([systemText ?? null, this.toolDefinitions ?? null])
    if (turnState?.chatContextHash !== contextHash) {
      if (systemText) attrs['gen_ai.system_instructions'] = t.text(systemText)
      if (this.toolDefinitions) {
        attrs['gen_ai.tool.definitions'] = this.toolDefinitions.map((def) => {
          const d = def as { name?: unknown; description?: unknown }
          return { name: String(d.name ?? ''), description: t.text(String(d.description ?? '')) }
        })
      }
      if (turnState) turnState.chatContextHash = contextHash
    }
    if (t.truncated) attrs['agent.custom.content_truncated'] = true
  }

  // ---------------------------------------------------------------- tools

  private onToolCall(event: SessionEvent): void {
    const d = event.data
    const turnState = this.turns.get(Number(d.turn))
    const step = this.steps.get(this.stepKey(Number(d.turn), Number(d.step)))
    if (!turnState || !step) return
    turnState.toolCallCount++
    const callId = String(d.callId)
    this.tools.set(callId, {
      callId,
      rootCallId: callId,
      turn: step.turn,
      step: step.step,
      name: String(d.name),
      argumentsRaw: d.arguments,
      startMs: event.time,
      spanId: spanIdFor(this.sessionId, paths.tool(step.turn, step.step, callId)),
      parentSpanId: step.spanId,
      traceId: turnState.traceId,
      nested: false,
      escalationWaitMs: 0,
      events: [],
    })
  }

  private onPtcStart(event: SessionEvent): void {
    const d = event.data
    const root = this.tools.get(String(d.rootCallId))
    const parent = this.tools.get(String(d.parentCallId)) ?? root
    if (!root || !parent) return
    const subCallId = String(d.subCallId)
    this.tools.set(subCallId, {
      callId: subCallId,
      rootCallId: root.callId,
      turn: root.turn,
      step: root.step,
      name: String(d.name),
      argumentsRaw: d.arguments,
      startMs: event.time,
      spanId: spanIdFor(this.sessionId, paths.tool(root.turn, root.step, subCallId)),
      parentSpanId: parent.spanId,
      traceId: root.traceId,
      nested: true,
      escalationWaitMs: 0,
      events: [],
    })
  }

  private onToolResult(event: SessionEvent, hints: LiveHints): void {
    const d = event.data
    const message = d.message as Message | undefined
    const callId = String(message?.source?.callId ?? message?.toolCallId ?? '')
    const tool = this.tools.get(callId)
    if (!tool) return
    this.tools.delete(callId)
    const turnState = this.turns.get(tool.turn)
    if (turnState) turnState.messageCount++
    this.emitTool(tool, event.time, {
      isError: message?.isError === true,
      content: message?.content,
      error: d.error,
      ...(hints.toolDurationMs !== undefined ? { liveDurationMs: hints.toolDurationMs } : {}),
    })
    for (const [id, nested] of this.tools) if (nested.nested && nested.rootCallId === callId) this.tools.delete(id)
  }

  private onPtcEnd(event: SessionEvent, hints: LiveHints): void {
    const d = event.data
    const tool = this.tools.get(String(d.subCallId))
    if (!tool) return
    this.tools.delete(tool.callId)
    this.emitTool(tool, event.time, {
      isError: d.isError === true,
      content: d.content,
      error: d.error,
      ...(hints.toolDurationMs !== undefined ? { liveDurationMs: hints.toolDurationMs } : {}),
    })
  }

  private emitTool(
    tool: ToolState,
    endMs: number,
    result: { isError: boolean; content?: Message['content']; error?: { name?: string; code?: string }; liveDurationMs?: number },
  ): void {
    const notDispatched = tool.admissionOutcome !== undefined && tool.admissionOutcome !== 'allowed-once'
    let duration: number | undefined
    let durationSource: 'execute' | 'events' | undefined
    if (!notDispatched) {
      if (result.liveDurationMs !== undefined) {
        duration = result.liveDurationMs - tool.escalationWaitMs
        durationSource = 'execute'
      } else {
        duration = endMs - (tool.admissionDecidedMs ?? tool.startMs) - tool.escalationWaitMs
        durationSource = 'events'
      }
    }
    const errorType = result.isError ? String(result.error?.code ?? 'tool_error') : undefined
    const mcp = /^mcp__(.+?)__/.exec(tool.name)
    const attrs: Attributes = {
      ...this.common(tool.turn, tool.step),
      'gen_ai.span.kind': 'tool',
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': tool.name,
      'gen_ai.tool.type': 'function',
      'gen_ai.tool.call.id': tool.callId,
      ...(duration !== undefined ? { 'gen_ai.tool.call.duration_ms': ms(duration), 'agent.custom.duration_source': durationSource } : {}),
      ...(notDispatched ? { 'agent.custom.not_dispatched': true } : {}),
      ...(tool.admissionOutcome ? { 'agent.custom.approval_outcome': tool.admissionOutcome, 'agent.custom.approval_wait_ms': ms(tool.admissionWaitMs ?? 0) } : {}),
      ...(tool.escalationOutcome ? { 'agent.custom.escalation_outcome': tool.escalationOutcome, 'agent.custom.escalation_wait_ms': ms(tool.escalationWaitMs) } : {}),
      ...(tool.nested ? { 'agent.custom.ptc_root_call_id': tool.rootCallId } : {}),
      ...(mcp ? { 'agent.custom.mcp_server': mcp[1] } : {}),
      ...(errorType ? { 'gen_ai.tool.error.type': errorType, 'error.type': errorType } : {}),
    }
    if (result.isError) attrs['gen_ai.tool.error.message'] = String(result.error?.name ?? errorType)
    if (this.options.captureContent) {
      const t = new Truncator(this.options.maxContentChars)
      attrs['gen_ai.tool.call.arguments'] = this.parseArguments(tool.argumentsRaw, t)
      const text = (result.content ?? []).map((b) => (b.type === 'text' ? String((b as { text: string }).text) : `[${b.type}]`)).join('')
      attrs['gen_ai.tool.call.result'] = t.text(text)
      if (result.isError) attrs['gen_ai.tool.error.message'] = t.text(text)
      if (t.truncated) attrs['agent.custom.content_truncated'] = true
    }
    this.emit({
      traceId: tool.traceId,
      spanId: tool.spanId,
      parentSpanId: tool.parentSpanId,
      name: `execute_tool ${tool.name}`,
      kind: SpanKind.Internal,
      startNs: ns(tool.startMs),
      endNs: ns(Math.max(endMs, tool.startMs)),
      attributes: attrs,
      status: result.isError ? { code: StatusCode.Error, message: errorType ?? 'tool_error' } : { code: StatusCode.Ok },
      ...(tool.events.length > 0 ? { events: tool.events } : {}),
    })
  }

  private parseArguments(raw: unknown, t: Truncator): Attributes[string] {
    let value = raw
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw) } catch { return t.text(raw) }
    }
    const json = JSON.stringify(value ?? null)
    if (json.length > this.options.maxContentChars) return t.text(json)
    return value !== null && typeof value === 'object' ? (value as Attributes[string]) : t.text(json)
  }

  // ---------------------------------------------------------------- approvals

  private onApprovalAsked(event: SessionEvent): void {
    const d = event.data
    this.approvals.set(String(d.id), {
      ...(d.callId ? { callId: String(d.callId) } : {}),
      askedMs: event.time,
      escalation: typeof d.reason === 'string' && d.reason.startsWith('escalate sandbox to '),
    })
  }

  private onApprovalDecided(event: SessionEvent): void {
    const d = event.data
    const asked = this.approvals.get(String(d.id))
    if (!asked) return
    this.approvals.delete(String(d.id))
    const outcome = outcomeName(d.outcome)
    const wait = event.time - asked.askedMs
    const tool = asked.callId ? this.tools.get(asked.callId) : undefined
    const name = asked.escalation ? 'escalation' : 'approval'
    const attributes: Attributes = { 'agent.custom.outcome': outcome, 'agent.custom.wait_ms': ms(wait) }
    if (!tool) {
      this.addTurnEvent(name, event.time, attributes)
      return
    }
    if (asked.escalation) {
      tool.escalationWaitMs += Math.max(0, wait)
      tool.escalationOutcome = outcome
    } else {
      tool.admissionDecidedMs = event.time
      tool.admissionOutcome = outcome
      tool.admissionWaitMs = Math.max(0, wait)
    }
    tool.events.push({ timeNs: ns(event.time), name, attributes })
  }

  // ---------------------------------------------------------------- common

  /**
   * Subagents use the name their parent reserved for them (`subagent/catalog.name`, unique
   * among siblings, e.g. `agent-1`) — the name the model addresses them by. Resolved lazily
   * at emit time because the parent records it during spawn.
   */
  private agentName(): string {
    if (this.header.origin === 'subagent' || this.header.parentSession) {
      const name = this.header.parentSession ? this.resolveName?.(this.header.parentSession, this.sessionId) : undefined
      if (name) return name
      if (this.header.origin === 'subagent') return this.header.agentPreset ?? 'subagent'
    }
    return this.header.agentPreset ?? 'main'
  }

  private common(turn: number, step?: number): Attributes {
    const system = systemName(this.config?.provider)
    return {
      ...this.options.commonAttributes,
      'gen_ai.agent.name': this.agentName(),
      'gen_ai.agent.id': this.sessionId,
      'gen_ai.session.id': this.sessionId,
      'gen_ai.turn.id': `${this.sessionId}:t${turn}`,
      ...(step !== undefined ? { 'gen_ai.step.id': `${this.sessionId}:t${turn}:s${step}` } : {}),
      ...(system ? { 'gen_ai.system': system } : {}),
      ...(this.header.cwd ? { 'workspace.current_root': this.header.cwd } : {}),
      ...(this.header.origin === 'subagent' ? { 'gen_ai.agent.scope': 'subagent' } : {}),
      ...(this.parent ? { 'gen_ai.subagent.parent_tool_call.id': this.parent.callId } : {}),
      ...(this.header.parentSession ? { 'agent.custom.parent_session_id': this.header.parentSession } : {}),
      ...(typeof this.header.delegationDepth === 'number' && this.header.delegationDepth > 0 ? { 'agent.custom.delegation_depth': this.header.delegationDepth } : {}),
      ...(this.options.source === 'replay' ? { 'agent.custom.source': 'replay' } : {}),
    }
  }
}
