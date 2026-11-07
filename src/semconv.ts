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
export function finishReasonName(kind: string): string {
  switch (kind) {
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    default: return kind
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

export class Truncator {
  private readonly maxChars: number
  truncated = false
  constructor(maxChars: number) {
    this.maxChars = maxChars
  }
  text(value: string): string {
    if (value.length <= this.maxChars) return value
    this.truncated = true
    return `${value.slice(0, this.maxChars)}…[truncated ${value.length - this.maxChars} chars]`
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
      return { type: 'tool_call', id: b.id, name: b.name, arguments: t.text(b.arguments) }
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
