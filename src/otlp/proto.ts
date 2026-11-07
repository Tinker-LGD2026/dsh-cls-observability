/**
 * Minimal protobuf wire-format writer: just enough for OTLP trace export.
 * Zero dependencies; nested messages are encoded child-first and embedded
 * as length-delimited fields.
 */

const encoder = new TextEncoder()

const WireType = {
  Varint: 0,
  Fixed64: 1,
  LengthDelimited: 2,
  Fixed32: 5,
} as const
type WireType = (typeof WireType)[keyof typeof WireType]

export class ProtoWriter {
  private chunks: Uint8Array[] = []
  private size = 0

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.size += bytes.length
  }

  private tag(field: number, wire: WireType): void {
    this.rawVarint(BigInt((field << 3) | wire))
  }

  private rawVarint(value: bigint): void {
    let v = BigInt.asUintN(64, value)
    const out: number[] = []
    while (v > 0x7fn) {
      out.push(Number(v & 0x7fn) | 0x80)
      v >>= 7n
    }
    out.push(Number(v))
    this.push(Uint8Array.from(out))
  }

  /** uint32 / enum / bool / int64 (two's complement for negatives). */
  varint(field: number, value: number | bigint | boolean): this {
    const v = typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value)
    if (v === 0n) return this
    this.tag(field, WireType.Varint)
    this.rawVarint(v)
    return this
  }

  /** Always-emitted varint (for oneof members where zero is meaningful). */
  varintAlways(field: number, value: number | bigint | boolean): this {
    const v = typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value)
    this.tag(field, WireType.Varint)
    this.rawVarint(v)
    return this
  }

  fixed64(field: number, value: bigint): this {
    if (value === 0n) return this
    this.tag(field, WireType.Fixed64)
    const buf = new Uint8Array(8)
    new DataView(buf.buffer).setBigUint64(0, BigInt.asUintN(64, value), true)
    this.push(buf)
    return this
  }

  fixed32(field: number, value: number): this {
    if (value === 0) return this
    this.tag(field, WireType.Fixed32)
    const buf = new Uint8Array(4)
    new DataView(buf.buffer).setUint32(0, value >>> 0, true)
    this.push(buf)
    return this
  }

  /** Always-emitted double (oneof member). */
  doubleAlways(field: number, value: number): this {
    this.tag(field, WireType.Fixed64)
    const buf = new Uint8Array(8)
    new DataView(buf.buffer).setFloat64(0, value, true)
    this.push(buf)
    return this
  }

  bytes(field: number, value: Uint8Array, always = false): this {
    if (value.length === 0 && !always) return this
    this.tag(field, WireType.LengthDelimited)
    this.rawVarint(BigInt(value.length))
    this.push(value)
    return this
  }

  string(field: number, value: string | undefined, always = false): this {
    if (value === undefined) return this
    if (value.length === 0 && !always) return this
    return this.bytes(field, encoder.encode(value), always)
  }

  message(field: number, build: (w: ProtoWriter) => void, always = false): this {
    const child = new ProtoWriter()
    build(child)
    return this.bytes(field, child.finish(), always)
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}
