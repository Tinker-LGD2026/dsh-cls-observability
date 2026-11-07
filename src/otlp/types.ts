/** Exporter-facing span model (OTLP-shaped, transport-agnostic). */

/** Force double encoding for a numeric attribute (plain integers encode as int64). */
export interface DoubleValue { readonly $double: number }

export type AttrValue =
  | string
  | boolean
  | number
  | bigint
  | DoubleValue
  | readonly AttrValue[]
  | { readonly [key: string]: AttrValue }

export type Attributes = Record<string, AttrValue | undefined>

export function double(value: number): DoubleValue {
  return { $double: value }
}

export const SpanKind = {
  Unspecified: 0,
  Internal: 1,
  Server: 2,
  Client: 3,
  Producer: 4,
  Consumer: 5,
} as const
export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind]

export const StatusCode = { Unset: 0, Ok: 1, Error: 2 } as const
export type StatusCode = (typeof StatusCode)[keyof typeof StatusCode]

export interface SpanEvent {
  timeNs: bigint
  name: string
  attributes?: Attributes
}

export interface SpanLink {
  traceId: string
  spanId: string
  attributes?: Attributes
}

export interface SpanRecord {
  /** 32 lowercase hex chars. */
  traceId: string
  /** 16 lowercase hex chars. */
  spanId: string
  parentSpanId?: string
  name: string
  kind: SpanKind
  startNs: bigint
  endNs: bigint
  attributes: Attributes
  status?: { code: StatusCode; message?: string }
  events?: SpanEvent[]
  links?: SpanLink[]
}

export interface ExportBatch {
  resource: Attributes
  scope: { name: string; version: string }
  spans: SpanRecord[]
}
