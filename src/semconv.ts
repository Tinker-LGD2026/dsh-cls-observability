import type { Redactor } from './redact.ts'
/** AgentObs semantic helpers: stream decoding, finish-reason mapping, content projection. */
import type { AssistantStreamRecord, ContentBlock, FinishReason, Message, StreamChunk, TokenUsage } from './dsh-types.ts'
import type { AttrValue, Attributes } from './otlp/types.ts'

export interface StreamFacts {
  firstTokenTime?: number
  finishTime?: number
  finish?: FinishReason
  usage?: TokenUsage
}

function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Read first-token time, finish, and usage from a compact durable stream (mirrors dsh-llm readers). */
export function readStream(stream: readonly AssistantStreamRecord[] | undefined): StreamFacts {
  const facts: StreamFacts = {}
  for (const record of stream ?? []) {
    if (record.type === 'chunk') {
      const chunk = record.chunk
      if (facts.firstTokenTime === undefined && isTokenDelta(chunk)) facts.firstTokenTime = record.time
      if (chunk.type === 'usage') facts.usage = chunk.usage
      else if (chunk.type === 'finish') {
        facts.finish = chunk.reason
        facts.finishTime = record.time
      }
      continue
    }
    if (facts.firstTokenTime !== undefined) continue
    if (record.type === 'tool-call-chunks' && record.name !== undefined) {
      facts.firstTokenTime = record.time0
      continue
    }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    let time = record.time0
    for (let i = 0; i < members.length; i++) {
      if (i > 0) time += record.dt[i - 1] ?? 0
      if (members[i] !== '') {
        facts.firstTokenTime = time
        break
      }
    }
  }
  return facts
}

/** DSH FinishReason.kind → OTel GenAI finish reason. Unknown kinds pass through. */
/** DSH finish kind → `gen_ai.response.finish_reasons` value (stop / tool_calls / length / cancelled / error). */
export function finishReasonName(kind: string): string {
  switch (kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted': return 'cancelled'
    case 'stop':
    case 'error': return kind
    default: return kind.replace(/-/g, '_')
  }
}

/**
 * Chat finish reason → `gen_ai.react.finish_reason` (tool_calls / stop / error). A round
 * cut at the output limit still ended without tool calls (`stop`); an interrupted or
 * failed round is `error`. DSH has no round limit, so `max_rounds` never occurs.
 */
export function reactFinishReason(chatFinish: string | undefined): string {
  switch (chatFinish) {
    case 'tool_calls': return 'tool_calls'
    case 'stop':
    case 'length': return 'stop'
    default: return 'error'
  }
}

export function usageAttributes(usage: TokenUsage | undefined): Attributes {
  if (!usage) return {}
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const miss = n(usage.inputTokens)
  const read = n(usage.cacheReadTokens)
  const write = n(usage.cacheWriteTokens)
  const input = miss + read + write
  const output = n(usage.outputTokens)
  return {
    'gen_ai.usage.input_tokens': input,
    'gen_ai.usage.output_tokens': output,
    'gen_ai.usage.total_tokens': typeof usage.totalTokens === 'number' ? usage.totalTokens : input + output,
    'gen_ai.usage.cache_miss.input_tokens': miss,
    ...(usage.cacheReadTokens !== undefined ? { 'gen_ai.usage.cache_read.input_tokens': read } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { 'gen_ai.usage.cache_creation.input_tokens': write } : {}),
    ...(usage.reasoningTokens !== undefined ? { 'gen_ai.usage.reasoning_output_tokens': n(usage.reasoningTokens) } : {}),
  }
}

/** Characters past the kept length still scanned, so a secret cut in half is masked whole. */
const REDACT_MARGIN = 4096

/** Content filter for one span: redacts secrets, then truncates each field. */
export class Truncator {
  private readonly maxChars: number
  private readonly redactor: Redactor | undefined
  truncated = false
  /** Names of the redaction rules that matched. */
  readonly redacted = new Set<string>()
  constructor(maxChars: number, redactor?: Redactor) {
    this.maxChars = maxChars
    this.redactor = redactor
  }
  text(value: string): string {
    // Redact only what can be kept (plus a margin, so a secret straddling the cut is still
    // recognised whole): bounds the work on huge tool output, and nothing past it is sent.
    const input = this.redactor && value.length > this.maxChars + REDACT_MARGIN ? value.slice(0, this.maxChars + REDACT_MARGIN) : value
    const clean = this.redactor ? this.redactor.text(input, this.redacted) : value
    if (clean.length <= this.maxChars && input.length === value.length) return clean
    if (clean.length <= this.maxChars) {
      this.truncated = true
      return `${clean}…[truncated ${value.length - input.length} chars]`
    }
    this.truncated = true
    return `${clean.slice(0, this.maxChars)}…[truncated ${clean.length - this.maxChars + value.length - input.length} chars]`
  }
  /**
   * Tool-call arguments as text: when they parse as JSON, values under credential-named
   * keys are masked whole (as on the tool span), then the text is redacted and truncated.
   */
  json(raw: string): string {
    if (this.redactor && raw.length <= 1_000_000 && /^\s*[[{]/.test(raw)) {
      try {
        const hits = new Set<string>()
        const masked = JSON.stringify(this.redactor.value(JSON.parse(raw), hits))
        if (hits.has('key') && masked !== undefined) {
          for (const h of hits) this.redacted.add(h)
          return this.text(masked)
        }
      } catch { /* not JSON: plain text below */ }
    }
    return this.text(raw)
  }

  /** Redact a structured value (e.g. parsed tool arguments) without truncating it. */
  value(value: unknown): unknown {
    return this.redactor ? this.redactor.value(value, this.redacted) : value
  }
  /** Span attributes describing what this filter changed. */
  marks(): Record<string, boolean | string[]> {
    return {
      ...(this.truncated ? { 'agent.custom.content_truncated': true } : {}),
      ...(this.redacted.size > 0 ? { 'agent.custom.content_redacted': true, 'agent.custom.redacted_types': [...this.redacted].sort() } : {}),
    }
  }
}

function blockToPart(block: ContentBlock, t: Truncator): AttrValue {
  switch (block.type) {
    case 'text':
      return { type: 'text', content: t.text(String((block as { text: string }).text)) }
    case 'reasoning':
      return { type: 'reasoning', content: t.text(String((block as { text: string }).text)) }
    case 'tool-call': {
      const b = block as { id: string; name: string; arguments: string }
      return { type: 'tool_call', id: b.id, name: b.name, arguments: t.json(b.arguments) }
    }
    default:
      return { type: String(block.type) }
  }
}

/** DSH message → OTel GenAI message (`{role, parts}`). */
export function messageToGenAi(message: Message, t: Truncator): AttrValue {
  if (message.role === 'tool') {
    const text = message.content.map((b) => (b.type === 'text' ? String((b as { text: string }).text) : `[${b.type}]`)).join('')
    return {
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: String(message.toolCallId ?? message.source?.callId ?? ''), response: t.text(text) }],
    }
  }
  // Providers often stream an empty reasoning/text block; it carries nothing for a reader.
  const blocks = message.content.filter((b) => !((b.type === 'text' || b.type === 'reasoning') && String((b as { text?: unknown }).text ?? '') === ''))
  return { role: message.role, parts: blocks.map((b) => blockToPart(b, t)) }
}

export function contentText(blocks: readonly ContentBlock[] | undefined): string {
  return (blocks ?? []).map((b) => (b.type === 'text' ? String((b as { text: string }).text) : '')).join('')
}

/** Keys of the AgentObs standard namespace that custom attributes must not overwrite. */
export function isReservedKey(key: string): boolean {
  return !key.startsWith('agent.custom.')
}
