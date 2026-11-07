/**
 * CLS AgentObs span validator (development aid, not part of the plugin bundle).
 *
 * Checks spans against the CLS AgentObs trace field definitions and the five-level
 * entry → agent → step → chat / tool model: kinds and operation names, span names,
 * id formats, required fields, value sets, message shapes, the full / delta exclusivity
 * of chat input, and parent-child structure. Works on plugin output (`SpanRecord`) and
 * on spans read back from CLS (`fromStored`).
 */
import type { SpanRecord } from './otlp/types.ts'

export interface CheckedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** OK / ERROR / UNSET */
  status: string
  attributes: Record<string, unknown>
}

export interface Issue {
  span: string
  problem: string
}

export interface ValidateOptions {
  /** Content capture was on: chat input/output and tool arguments/result are required. */
  content: boolean
  /** All spans of each trace are present: check parents and the single entry root. */
  complete?: boolean
  /**
   * Spans read back from CLS. Tolerates what the CLS ingest pipeline itself adds or
   * rewrites: derived `gen_ai.usage.details` / `gen_ai.request.parameters`, and a
   * subagent's `invoke_subagent` name prefix stored as `invoke_agent`.
   */
  stored?: boolean
}

const STORED_DERIVED = new Set(['gen_ai.usage.details', 'gen_ai.request.parameters'])

/** `gen_ai.*` fields defined by the CLS AgentObs trace specification. */
const GEN_AI_FIELDS = new Set([
  'gen_ai.span.kind', 'gen_ai.operation.name', 'gen_ai.agent.type', 'gen_ai.agent.id', 'gen_ai.agent.name',
  'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.step.id', 'gen_ai.user.id', 'gen_ai.user.name', 'gen_ai.entry.type',
  'gen_ai.entry.platform', 'gen_ai.entry.channel_id', 'gen_ai.system', 'gen_ai.agent.scope',
  'gen_ai.subagent.parent_tool_call.id', 'gen_ai.agent.message_count', 'gen_ai.agent.tool_call_count',
  'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.response.model', 'gen_ai.response.finish_reasons',
  'gen_ai.chat.duration_ms', 'gen_ai.input.messages', 'gen_ai.input.messages.hash', 'gen_ai.input.messages_delta',
  'gen_ai.output.messages', 'gen_ai.response.id', 'gen_ai.response.time_to_first_token_ms', 'gen_ai.request.temperature',
  'gen_ai.request.top_p', 'gen_ai.request.top_k', 'gen_ai.request.max_tokens', 'gen_ai.request.frequency_penalty',
  'gen_ai.request.presence_penalty', 'gen_ai.request.stop_sequences', 'gen_ai.request.seed', 'gen_ai.request.id',
  'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens',
  'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_miss.input_tokens',
  'gen_ai.usage.reasoning_output_tokens', 'gen_ai.usage.input_cost', 'gen_ai.usage.output_cost',
  'gen_ai.usage.cache_read.input_cost', 'gen_ai.usage.cache_creation.input_cost', 'gen_ai.usage.total_cost',
  'gen_ai.tool.call.id', 'gen_ai.tool.name', 'gen_ai.tool.type', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result',
  'gen_ai.tool.call.duration_ms', 'gen_ai.tool.error.type', 'gen_ai.tool.error.message', 'gen_ai.tool.call.exec.id',
  'gen_ai.tool.call.image.count', 'gen_ai.tool.call.image.paths', 'gen_ai.tool.call.image.duration',
  'gen_ai.react.round', 'gen_ai.react.finish_reason', 'gen_ai.react.thought', 'gen_ai.react.observation',
  'gen_ai.system_instructions', 'gen_ai.tool.definitions', 'gen_ai.skill.name',
  'gen_ai.chain.name', 'gen_ai.chain.input', 'gen_ai.chain.output', 'gen_ai.chain.metadata',
  'gen_ai.retrieval.query_text', 'gen_ai.retrieval.documents', 'gen_ai.retrieval.documents.count', 'gen_ai.retrieval.duration_ms',
  'gen_ai.rerank.query_text', 'gen_ai.rerank.input_documents', 'gen_ai.rerank.input_documents.count',
  'gen_ai.rerank.output_documents', 'gen_ai.rerank.output_documents.count', 'gen_ai.rerank.duration_ms',
])

const OPERATIONS: Record<string, readonly string[]> = {
  entry: ['enter_application'],
  agent: ['invoke_agent', 'invoke_subagent'],
  step: ['react'],
  chat: ['chat'],
  tool: ['execute_tool'],
}

const REQUIRED: Record<string, readonly string[]> = {
  entry: ['gen_ai.session.id', 'gen_ai.turn.id'],
  agent: ['gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.agent.type', 'gen_ai.agent.name'],
  step: ['gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.step.id', 'gen_ai.react.round', 'gen_ai.react.finish_reason'],
  chat: ['gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.step.id', 'gen_ai.request.model', 'gen_ai.response.finish_reasons'],
  tool: ['gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.step.id', 'gen_ai.tool.name', 'gen_ai.tool.type', 'gen_ai.tool.call.id'],
}

const CHAT_FINISH = new Set(['stop', 'tool_calls', 'end_turn', 'length', 'cancelled', 'content_filter', 'error'])
const REACT_FINISH = new Set(['tool_calls', 'stop', 'error', 'max_rounds'])
const TOOL_TYPES = new Set(['function', 'mcp', 'retrieval'])
const USAGE = /^gen_ai\.usage\./

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function messagesProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return 'is not an array'
  for (const m of value) {
    const msg = m as { role?: unknown; parts?: unknown }
    if (typeof msg?.role !== 'string') return 'has a message without a role'
    if (!Array.isArray(msg.parts)) return 'has a message without parts'
    if (msg.parts.some((p) => typeof (p as { type?: unknown })?.type !== 'string')) return 'has a part without a type'
  }
  return undefined
}

export function validateSpans(spans: readonly CheckedSpan[], options: ValidateOptions): Issue[] {
  const issues: Issue[] = []
  const byId = new Map(spans.map((s) => [s.spanId, s]))
  for (const s of spans) {
    const a = s.attributes
    const kind = String(a['gen_ai.span.kind'])
    const label = `${kind} ${s.name} (${s.spanId})`
    const add = (problem: string) => issues.push({ span: label, problem })

    const ops = OPERATIONS[kind]
    if (!ops) { add(`unknown gen_ai.span.kind "${kind}"`); continue }
    const op = String(a['gen_ai.operation.name'])
    if (!ops.includes(op)) add(`operation "${op}" is not valid for ${kind}`)
    for (const key of REQUIRED[kind]!) if (a[key] === undefined || a[key] === '') add(`missing ${key}`)
    for (const key of Object.keys(a)) {
      if (key.startsWith('gen_ai.') && !GEN_AI_FIELDS.has(key) && !(options.stored && STORED_DERIVED.has(key))) add(`${key} is not a CLS AgentObs field`)
    }
    if (kind !== 'chat' && Object.keys(a).some((k) => USAGE.test(k) && !STORED_DERIVED.has(k))) add('token usage outside a chat span is double counted')

    // Ids: <session>:t<N>, <turn>:s<N>.
    const session = String(a['gen_ai.session.id'] ?? '')
    const turn = String(a['gen_ai.turn.id'] ?? '')
    if (!new RegExp(`^${escape(session)}:t\\d+$`).test(turn)) add(`turn.id "${turn}" is not <session-id>:t<N>`)
    if (a['gen_ai.step.id'] !== undefined && !new RegExp(`^${escape(turn)}:s\\d+$`).test(String(a['gen_ai.step.id']))) {
      add(`step.id "${String(a['gen_ai.step.id'])}" is not <turn-id>:s<N>`)
    }
    const round = a['gen_ai.react.round']
    if (round !== undefined && (!Number.isInteger(round) || (round as number) < 1)) add('react.round is not a positive integer')
    if (round !== undefined && a['gen_ai.step.id'] !== undefined && !String(a['gen_ai.step.id']).endsWith(`:s${String(round)}`)) {
      add('react.round does not match step.id')
    }

    const subagent = a['gen_ai.agent.scope'] === 'subagent'
    switch (kind) {
      case 'entry':
        if (s.name !== 'enter_application') add('name is not "enter_application"')
        if (s.parentSpanId) add('entry is a trace root and must have no parent')
        break
      case 'agent':
        if (s.name !== `${op} ${String(a['gen_ai.agent.name'])}` && !(options.stored && s.name === `invoke_agent ${String(a['gen_ai.agent.name'])}`)) {
          add(`name is not "${op} <agent.name>"`)
        }
        if (subagent && op !== 'invoke_subagent') add('a subagent must use invoke_subagent')
        break
      case 'step':
        if (s.name !== `react round_${String(round)}`) add('name is not "react round_<react.round>"')
        if (!REACT_FINISH.has(String(a['gen_ai.react.finish_reason']))) add(`react.finish_reason "${String(a['gen_ai.react.finish_reason'])}" is not tool_calls / stop / error / max_rounds`)
        break
      case 'chat': {
        if (s.name !== `chat ${String(a['gen_ai.request.model'])}`) add('name is not "chat <request.model>"')
        const finish = a['gen_ai.response.finish_reasons']
        if (finish !== undefined && (!Array.isArray(finish) || finish.some((f) => !CHAT_FINISH.has(String(f))))) add(`finish_reasons ${JSON.stringify(finish)} has a value outside the spec`)
        // Required unless the provider reported none (marked) or the call failed.
        if (s.status !== 'ERROR' && a['agent.custom.usage_unavailable'] !== true
          && (a['gen_ai.usage.input_tokens'] === undefined || a['gen_ai.usage.output_tokens'] === undefined)) add('missing token usage')
        break
      }
      case 'tool':
        if (s.name !== `execute_tool ${String(a['gen_ai.tool.name'])}`) add('name is not "execute_tool <tool.name>"')
        if (!TOOL_TYPES.has(String(a['gen_ai.tool.type']))) add(`tool.type "${String(a['gen_ai.tool.type'])}" is not function / mcp / retrieval`)
        if (String(a['gen_ai.tool.name']).startsWith('mcp__') && a['gen_ai.tool.type'] !== 'mcp') add('an MCP tool must have tool.type "mcp"')
        break
    }

    // Messages.
    for (const key of ['gen_ai.input.messages', 'gen_ai.input.messages_delta', 'gen_ai.output.messages']) {
      if (a[key] === undefined) continue
      const problem = messagesProblem(a[key])
      if (problem) add(`${key} ${problem}`)
    }
    if (a['gen_ai.input.messages_delta'] !== undefined) {
      if (kind !== 'chat') add('messages_delta only belongs on a chat span')
      if (a['gen_ai.input.messages'] !== undefined) add('input.messages and messages_delta are mutually exclusive')
    }
    if (options.content) {
      if (kind === 'chat') {
        if (a['gen_ai.input.messages'] === undefined && a['gen_ai.input.messages_delta'] === undefined) add('chat has neither input.messages nor messages_delta')
        if (a['gen_ai.input.messages.hash'] === undefined) add('chat input requires gen_ai.input.messages.hash')
        if (s.status === 'OK' && a['gen_ai.output.messages'] === undefined) add('a successful chat has no output.messages')
      }
      if (kind === 'tool' && (a['gen_ai.tool.call.arguments'] === undefined || a['gen_ai.tool.call.result'] === undefined)) add('tool has no arguments or result')
    }

    // Structure.
    if (options.complete && s.parentSpanId) {
      const parent = byId.get(s.parentSpanId)
      const pkind = parent ? String(parent.attributes['gen_ai.span.kind']) : undefined
      if (!parent) add('parent span is missing')
      else if (parent.traceId !== s.traceId) add('parent is in another trace')
      else {
        const ok = kind === 'agent' ? pkind === 'entry' || (pkind === 'tool' && subagent)
          : kind === 'step' ? pkind === 'agent'
          : kind === 'chat' ? pkind === 'step' || (pkind === 'agent' && a['agent.custom.llm_purpose'] !== undefined)
          : kind === 'tool' ? pkind === 'step' || (pkind === 'tool' && a['agent.custom.ptc_root_call_id'] !== undefined)
          : false
        if (!ok) add(`a ${kind} span cannot be a child of ${pkind}`)
        if (kind === 'agent' && pkind === 'tool' && a['gen_ai.subagent.parent_tool_call.id'] !== parent.attributes['gen_ai.tool.call.id']) {
          add('subagent.parent_tool_call.id does not match the parent tool call')
        }
      }
    }
    if (options.complete && kind !== 'entry' && !s.parentSpanId) add(`a ${kind} span must have a parent`)
  }
  if (options.complete) {
    const roots = new Map<string, number>()
    for (const s of spans) if (s.attributes['gen_ai.span.kind'] === 'entry') roots.set(s.traceId, (roots.get(s.traceId) ?? 0) + 1)
    for (const [trace, n] of roots) if (n > 1) issues.push({ span: `trace ${trace}`, problem: `${n} entry spans in one trace` })
  }
  return issues
}

const STATUS = ['UNSET', 'OK', 'ERROR']

export function fromRecord(span: SpanRecord): CheckedSpan {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    name: span.name,
    status: STATUS[span.status?.code ?? 0] ?? 'UNSET',
    attributes: span.attributes as Record<string, unknown>,
  }
}

/** A span as stored in CLS (`attribute` object, upper-case status). */
export function fromStored(span: { traceID: string; spanID: string; parentSpanID?: string | undefined; name: string; statusCode?: string | undefined; attribute: Record<string, unknown> }): CheckedSpan {
  return {
    traceId: span.traceID,
    spanId: span.spanID,
    ...(span.parentSpanID ? { parentSpanId: span.parentSpanID } : {}),
    name: span.name,
    status: span.statusCode ?? 'UNSET',
    attributes: span.attribute,
  }
}
