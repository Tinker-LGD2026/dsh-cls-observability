/**
 * Session → AgentObs span builder. Pure logic, shared by the live collector
 * and offline replay: feed Session events in log order (plus optional live
 * timing hints) and it emits entry/agent/step/chat/tool spans with
 * deterministic ids.
 */
import type { AssistantStreamRecord, FinishReason, LlmCallConfig, Message, SessionEvent, SessionHeader, TokenUsage } from './dsh-types.ts'
import { contentHash, paths, spanIdFor, traceIdFor } from './ids.ts'
import { SpanKind, StatusCode, double, type Attributes, type SpanEvent, type SpanLink, type SpanRecord } from './otlp/types.ts'
import type { Redactor } from './redact.ts'
import { Truncator, contentText, finishReasonName, messageToGenAi, reactFinishReason, readStream, usageAttributes } from './semconv.ts'

export interface BuilderOptions {
  captureContent: boolean
  maxContentChars: number
  /** Static attributes added to every span (agent.type, entry.*, user.*, agent.custom.*). */
  commonAttributes: Attributes
  /** Secret redaction for captured content; undefined when disabled. */
  redactor?: Redactor
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
  /** Request as the provider sees it; present only when content capture is on. */
  messages?: readonly Message[]
  system?: string
  /** Assistant reply assembled from the stream. */
  output?: Message
  /** Turn/round the call belongs to, captured when its request started. */
  anchor?: AuxAnchor
}

export interface AuxAnchor {
  turn: number
  /** Round the call belongs to: the open step, or the one being prepared. */
  step: number
  traceId: string
  parentSpanId: string
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
  /** Counts as a conversation message in chat input (not system / developer, not empty). */
  conversation: boolean
  /** Model-visible (dormant empty nodes are not). */
  visible: boolean
  /** Hash of this node's own raw (untruncated) content; '' when not visible. */
  own: string
  /** Rolling hash of all visible raw content up to and including this node. */
  chain: string
  /** Number of conversation messages before this node. */
  conversationIndex: number
  /** Body, kept only while it may still be reported; released afterwards. */
  message?: Message
  /** System prompt text of a system node (always kept: one per session). */
  systemText?: string
}

/** Already reported messages kept for a full report after a prefix change. */
const FULL_REPORT_TAIL = 64

/** Re-chain a node after an earlier part of the surface was replaced. */
function rechain(n: SurfaceNode, prev: SurfaceNode): SurfaceNode {
  return {
    ...n,
    chain: n.visible ? contentHash([prev.chain, n.own]) : prev.chain,
    conversationIndex: prev.conversationIndex + (prev.conversation ? 1 : 0),
  }
}

const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

interface TurnState {
  turn: number
  traceId: string
  entryId: string
  agentId: string
  /** Tool span a nested subagent turn hangs off; such a turn has no entry span. */
  toolParentId?: string
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
  /** Highest step number started in this turn (0 before the first). */
  lastStep: number
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

/** Index of the first message to keep so the tail fits `budget` chars (the last message always stays). */
function recentFrom(messages: readonly Message[], budget: number): number {
  let used = 0
  let from = messages.length
  while (from > 0) {
    const size = JSON.stringify(messages[from - 1]!.content).length
    if (used + size > budget && from < messages.length) break
    used += size
    from--
  }
  return from
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
  /** Delta cursor: conversation messages already reported as chat input. */
  private reportedCount = 0
  private reportedAny = false
  /** An earlier part of the surface was rewritten since the last report. */
  private prefixChanged = false
  /** Surface index up to which reported bodies were released. */
  private released = 0
  private historyUnknown = false
  private catalog = new Map<string, string>()
  private config?: LlmCallConfig
  private contextWindow?: number
  private toolDefinitions?: unknown[]
  private openTurn?: number
  private turnRefs: TurnRef[] = []
  private standaloneAux = 0
  private auxCounts = new Map<number, number>()

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

  /**
   * Mirror the session's ordered model-visible surface (append / replace ops) at
   * constant cost per event: each node carries a rolling hash of the context up to it,
   * and only a `replace` (compaction, system prompt swap) rewrites earlier context.
   */
  private applySurface(event: SessionEvent): void {
    const op = event.surfaceOp as undefined | 'append' | { op?: string; startSeq?: number; endSeq?: number }
    if (op === undefined || !SURFACE_TYPES.has(event.type)) return
    const message = (event.type === 'user/message' ? event.data : event.data?.message) as Message | undefined
    if (!message || !Array.isArray(message.content)) return
    const visible = message.content.length > 0 && !(message.role === 'system' && contentText(message.content) === '')
    const conversation = visible && message.role !== 'system' && message.role !== 'developer'
    const make = (prev: SurfaceNode | undefined): SurfaceNode => {
      const own = visible ? contentHash([message.role, message.content]) : ''
      return {
        seq: event.seq,
        conversation,
        visible,
        own,
        chain: visible ? contentHash([prev?.chain ?? '', own]) : prev?.chain ?? '',
        conversationIndex: (prev?.conversationIndex ?? 0) + (prev?.conversation ? 1 : 0),
        ...(visible ? { message } : {}),
        ...(message.role === 'system' && visible ? { systemText: contentText(message.content) } : {}),
      }
    }
    if (op === 'append') {
      this.surface.push(make(this.surface.at(-1)))
      return
    }
    const start = this.surface.findIndex((n) => n.seq === op.startSeq)
    const end = this.surface.findIndex((n) => n.seq === op.endSeq)
    if (op.op === 'replace' && start >= 0 && end >= start) {
      const tail = this.surface.splice(start)
      this.surface.push(make(this.surface.at(-1)))
      // Re-chain what followed the replaced range (rare: compaction, prompt swap).
      for (const n of tail.slice(end - start + 1)) this.surface.push(rechain(n, this.surface.at(-1)!))
      this.prefixChanged = true
    } else {
      // Replaced nodes we never saw: the mirrored surface can no longer be trusted as complete.
      this.historyUnknown = true
      this.prefixChanged = true
      this.surface.push(make(this.surface.at(-1)))
    }
  }

  /**
   * Drop message bodies the plugin no longer needs: nodes already reported, except a
   * recent tail kept for a full report after a prefix change. Hashes and seqs stay.
   */
  private releaseBodies(): void {
    const keepFrom = Math.max(0, this.reportedCount - FULL_REPORT_TAIL)
    for (let i = this.released; i < this.surface.length; i++) {
      const n = this.surface[i]!
      if (!n.conversation) continue
      if (n.conversationIndex >= keepFrom) break
      if (n.message && !n.systemText) delete n.message
      this.released = i + 1
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
    let toolParentId: string | undefined
    const entryLinks: SpanLink[] = []
    if (this.parent && !this.parentConsumed) {
      traceId = this.parent.traceId
      toolParentId = this.parent.spanId
      this.parentConsumed = true
    } else if (this.parent) {
      entryLinks.push({ traceId: this.parent.traceId, spanId: this.parent.spanId, attributes: { 'agent.custom.link_type': 'parent_tool_call' } })
    }
    const state: TurnState = {
      turn,
      traceId,
      entryId: spanIdFor(this.sessionId, paths.entry(turn)),
      agentId: spanIdFor(this.sessionId, paths.agent(turn)),
      ...(toolParentId ? { toolParentId } : {}),
      startMs: event.time,
      messageCount: 0,
      toolCallCount: 0,
      stepOneSources: [],
      firstUserMessages: [],
      triggerMessages: [],
      events: [],
      entryLinks,
      lastStep: 0,
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
    const t = new Truncator(this.options.maxContentChars, this.options.redactor)
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
    const truncated = { ...t.marks(), ...(state.contentTruncated ? { 'agent.custom.content_truncated': true } : {}) }
    const turnAttrs: Attributes = {
      ...this.common(turn),
      'agent.custom.turn_end_reason': reason.kind,
      'agent.custom.trigger': trigger,
      ...(reason.kind === 'error' && reason.error?.code ? { 'error.type': String(reason.error.code) } : {}),
      ...truncated,
    }

    // entry is a trace root. A subagent turn nested in its parent's trace has no entry:
    // its agent span hangs directly off the tool span that spawned it.
    const nested = state.toolParentId !== undefined
    this.emit({
      traceId: state.traceId,
      spanId: state.agentId,
      parentSpanId: state.toolParentId ?? state.entryId,
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
      ...(nested && state.entryLinks.length > 0 ? { links: state.entryLinks } : {}),
    })
    if (nested) return
    this.emit({
      traceId: state.traceId,
      spanId: state.entryId,
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
    const turnState = this.turns.get(turn)
    if (!turnState) return
    turnState.lastStep = Math.max(turnState.lastStep, step)
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
    // Required by the spec, always one of tool_calls / stop / error; the precise chat
    // outcome travels alongside when it is not one of those.
    const reactFinish = reactFinishReason(step.lastFinish)
    const detail = step.lastFinish ?? 'no_model_response'
    const failed = step.lastChatFailed || step.lastFinish === undefined
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
        'gen_ai.react.finish_reason': reactFinish,
        ...(detail !== reactFinish ? { 'agent.custom.react_finish_detail': detail } : {}),
      },
      status: failed ? { code: StatusCode.Error, message: detail } : { code: StatusCode.Ok },
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
    // A committed answer whose stream record carries no finish chunk (e.g. an empty or
    // compacted stream): it completed, and its content tells how.
    let finishInferred = false
    if (!facts.finish && event.type === 'assistant/message' && !data.interrupted && data.message) {
      facts.finish = { kind: data.message.content.some((b) => b.type === 'tool-call') ? 'tool-calls' : 'stop' } as FinishReason
      finishInferred = true
    }
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
      ...(finishInferred ? { extraAttrs: { 'agent.custom.finish_inferred': true } } : {}),
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
    step.lastFinish = facts.finish ? finishReasonName(facts.finish.kind) : (data.interrupted ? 'interrupted' : 'unknown')
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

  /**
   * Where an auxiliary call that starts now belongs, captured when its request starts
   * (the call may outlive the step or even the turn). Inside a step: that round. Between
   * rounds (e.g. compaction in `agent/pre-step`): the round it prepares, parented to the
   * agent span because that step span does not exist yet.
   */
  auxiliaryAnchor(): AuxAnchor | undefined {
    const turnState = this.openTurn !== undefined ? this.turns.get(this.openTurn) : undefined
    if (!turnState) return undefined
    const open = this.currentStep()
    return {
      turn: turnState.turn,
      step: open?.step ?? turnState.lastStep + 1,
      traceId: turnState.traceId,
      parentSpanId: open?.spanId ?? turnState.agentId,
    }
  }

  /** Auxiliary model call (compaction, session title, auto review), observed via `llm/stream`. */
  onAuxiliary(call: AuxiliaryCall): void {
    const anchor = call.anchor
    if (anchor) {
      const n = (this.auxCounts.get(anchor.turn) ?? 0) + 1
      this.auxCounts.set(anchor.turn, n)
      this.emit(this.chatSpan({
        traceId: anchor.traceId,
        parentSpanId: anchor.parentSpanId,
        spanId: spanIdFor(this.sessionId, paths.aux(anchor.turn, call.purpose, n)),
        turn: anchor.turn,
        step: anchor.step,
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
        contentAttrs: this.auxiliaryContent(call),
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
      contentAttrs: this.auxiliaryContent(call),
      links: last ? [{ traceId: last.traceId, spanId: last.agentSpanId, attributes: { 'agent.custom.link_type': 'auxiliary_after_turn' } }] : [],
    }))
  }

  /**
   * An auxiliary call is a standalone request (its prompt is not the session's context),
   * so it always reports its own full input, never a delta.
   */
  private auxiliaryContent(call: AuxiliaryCall): Attributes {
    if (!this.options.captureContent) return {}
    const t = new Truncator(this.options.maxContentChars, this.options.redactor)
    const messages = call.messages ?? []
    const conversation = messages.filter((m) => m.role !== 'system')
    const system = [call.system, ...messages.filter((m) => m.role === 'system').map((m) => contentText(m.content))].filter(Boolean).join('\n')
    const from = recentFrom(conversation, this.options.maxContentChars * 8)
    const attrs: Attributes = {}
    if (conversation.length > 0) {
      attrs['gen_ai.input.messages'] = conversation.slice(from).map((m) => messageToGenAi(m, t))
      attrs['gen_ai.input.messages.hash'] = contentHash(conversation.map((m) => [m.role, m.content]))
    }
    if (from > 0) attrs['agent.custom.input_messages_omitted'] = from
    if (system) attrs['gen_ai.system_instructions'] = t.text(system)
    if (call.output) attrs['gen_ai.output.messages'] = [messageToGenAi(call.output, t)]
    Object.assign(attrs, t.marks())
    return attrs
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
    contentAttrs?: Attributes
    extraAttrs?: Attributes
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
    // Required on chat: an attempt cut short without a finish chunk still has an outcome.
    const chatFinish = finishKind ? finishReasonName(finishKind) : input.interrupted ? 'cancelled' : input.abandoned ? 'error' : undefined
    const end = input.finishMs ?? input.endMs
    const attrs: Attributes = {
      ...this.common(input.turn, input.step),
      'gen_ai.span.kind': 'chat',
      'gen_ai.operation.name': 'chat',
      ...(provider ? { 'gen_ai.provider.name': systemName(provider), 'agent.custom.provider_route': provider } : {}),
      ...(model ? { 'gen_ai.request.model': model, 'gen_ai.response.model': model } : {}),
      ...(chatFinish ? { 'gen_ai.response.finish_reasons': [chatFinish] } : {}),
      ...(input.step !== undefined ? { 'gen_ai.react.round': input.step } : {}),
      'gen_ai.chat.duration_ms': ms(end - input.startMs),
      ...(input.firstTokenMs !== undefined ? { 'gen_ai.response.time_to_first_token_ms': ms(input.firstTokenMs - input.startMs) } : {}),
      ...(input.ttftApprox && this.options.source === 'replay' ? { 'agent.custom.ttft_approx': true } : {}),
      ...usageAttributes(input.usage),
      // The provider reported no usage: say so instead of reporting zero tokens.
      ...(input.usage ? {} : { 'agent.custom.usage_unavailable': true }),
      ...(input.purpose ? {} : this.requestAttributes()),
      ...(input.purpose ? { 'agent.custom.llm_purpose': input.purpose } : {}),
      ...(input.retryOf && input.retryIndex ? { 'agent.custom.retry_of': input.retryOf, 'agent.custom.retry_index': input.retryIndex } : {}),
      ...(input.replayable ? {} : { 'agent.custom.replayable': false }),
      ...input.extraAttrs,
      ...(finishKind === 'error' || finishKind === 'aborted'
        ? { 'error.type': String(input.finish?.failure?.code ?? finishKind) }
        : {}),
    }
    if (!input.purpose) this.addChatContent(attrs, input.output, input.inputAttrs)
    else if (input.contentAttrs) Object.assign(attrs, input.contentAttrs)
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

  /** Effective system prompt: the latest non-empty system node on the surface. */
  private systemText(): string | undefined {
    for (let i = this.surface.length - 1; i >= 0; i--) {
      const text = this.surface[i]!.systemText
      if (text) return text
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
   * Advances the delta cursor; call once per model request. Cost is proportional to
   * the messages reported, not to the session length.
   */
  private chatInputAttributes(): Attributes {
    const last = this.surface.at(-1)
    const total = last ? last.conversationIndex + (last.conversation ? 1 : 0) : 0
    const attrs: Attributes = {
      'gen_ai.input.messages.hash': contentHash([last?.chain ?? '']),
      'agent.custom.input_message_count': total,
    }
    let reset: string | undefined
    if (!this.reportedAny) reset = this.historyUnknown ? 'history_unknown' : 'first_report'
    else if (this.prefixChanged) reset = total < this.reportedCount ? 'context_shrank' : 'prefix_changed'
    const previous = this.reportedCount
    this.reportedAny = true
    this.reportedCount = total
    this.prefixChanged = false
    if (!this.options.captureContent) {
      this.releaseBodies()
      return attrs
    }

    const t = new Truncator(this.options.maxContentChars, this.options.redactor)
    // Newest conversation messages, oldest first, walking back only as far as needed.
    const tail = (count: number): Message[] => {
      const out: Message[] = []
      for (let i = this.surface.length - 1; i >= 0 && out.length < count; i--) {
        const n = this.surface[i]!
        if (!n.conversation) continue
        if (!n.message) break
        out.push(n.message)
      }
      return out.reverse()
    }
    if (reset === undefined) {
      attrs['gen_ai.input.messages_delta'] = tail(total - previous).map((m) => messageToGenAi(m, t))
    } else {
      // Bound one full report; keep the most recent messages when the history is very long.
      const available = tail(total)
      const from = recentFrom(available, this.options.maxContentChars * 8)
      attrs['gen_ai.input.messages'] = available.slice(from).map((m) => messageToGenAi(m, t))
      const omitted = total - available.length + from
      if (omitted > 0) attrs['agent.custom.input_messages_omitted'] = omitted
      if (reset !== 'first_report') attrs['agent.custom.input_delta_reset'] = reset
      if (this.historyUnknown) attrs['agent.custom.input_context_partial'] = true
    }
    Object.assign(attrs, t.marks())
    this.releaseBodies()
    return attrs
  }

  private addChatContent(attrs: Attributes, output: Message | undefined, inputAttrs: Attributes | undefined): void {
    if (inputAttrs) Object.assign(attrs, inputAttrs)
    if (!this.options.captureContent) return
    const t = new Truncator(this.options.maxContentChars, this.options.redactor)
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
    Object.assign(attrs, t.marks())
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
      'gen_ai.tool.type': mcp ? 'mcp' : 'function',
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
      const t = new Truncator(this.options.maxContentChars, this.options.redactor)
      attrs['gen_ai.tool.call.arguments'] = this.parseArguments(tool.argumentsRaw, t)
      const text = (result.content ?? []).map((b) => (b.type === 'text' ? String((b as { text: string }).text) : `[${b.type}]`)).join('')
      attrs['gen_ai.tool.call.result'] = t.text(text)
      if (result.isError) attrs['gen_ai.tool.error.message'] = t.text(text)
      Object.assign(attrs, t.marks())
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
    const clean = t.value(value ?? null)
    const json = JSON.stringify(clean)
    if (json.length > this.options.maxContentChars) return t.text(json)
    return clean !== null && typeof clean === 'object' ? (clean as Attributes[string]) : t.text(json)
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
