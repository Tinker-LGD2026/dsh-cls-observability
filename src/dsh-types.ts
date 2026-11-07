/**
 * Structural subset of DeepSeek Harness 0.2.x types this plugin reads.
 * Kept local so the bundle has zero runtime imports from DSH packages; every
 * field is treated as untrusted input and read defensively.
 * Source of truth: deepseek-harness packages/core/session/src/types.ts,
 * packages/llm/llm/src/{types,message,assistant-stream}.ts.
 */

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface LlmFailure {
  message: string
  code: string
  status?: number
}

export type FinishReason = { kind: string; failure?: LlmFailure }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
  | { type: 'image'; [k: string]: unknown }
  | { type: 'file'; [k: string]: unknown }
  | { type: string; [k: string]: unknown }

export interface MessageSource { kind: string; [k: string]: unknown }

export interface Message {
  id?: string
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: readonly ContentBlock[]
  source: MessageSource
  toolCallId?: string
  isError?: boolean
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

export type AssistantStreamRecord =
  | { type: 'text-chunks' | 'reasoning-chunks'; time0: number; index: number; dt: readonly number[]; texts: readonly string[] }
  | { type: 'tool-call-chunks'; time0: number; index: number; dt: readonly number[]; id: string; name?: string; args: readonly string[] }
  | { type: 'chunk'; time: number; chunk: StreamChunk }

export interface LlmCallConfig {
  provider: string
  model: string
  temperature?: number
  topP?: number
  maxTokens?: number
  stop?: string[]
  seed?: number
  reasoningEffort?: string
  [k: string]: unknown
}

export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: any
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

export interface SessionHeader {
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  isSeeded: boolean
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

/** Live Session object, as seen by listeners. */
export interface SessionLike {
  id: string
  header: SessionHeader
  inheritedEventCount: number
  firstLiveSeq: number
  firstLifecycleSeq: number
}

export interface AgentLike {
  session: SessionLike
}

export type AssistantStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: StreamChunk }
  | { type: 'end'; attemptId: string; revision: number; index: number; outcome: { kind: 'committed'; eventType: string; seq: number } | { kind: 'abandoned' } }

export interface ToolDispatchExecution {
  callId: string
  rootCallId: string
  name: string
  agent?: AgentLike
  parent?: symbol
}

export interface GenerateOptions {
  provider: string
  model: string
  sessionId?: string
  purpose?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}
