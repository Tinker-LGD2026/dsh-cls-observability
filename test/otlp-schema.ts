/** opentelemetry-proto v1 subset (trace export), used only to independently decode our output. */
import protobuf from 'protobufjs'

const PROTO = `
syntax = "proto3";
package opentelemetry.proto;
message AnyValue {
  oneof value {
    string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4;
    ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message Span {
  bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; fixed32 flags = 16;
  string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9; uint32 dropped_attributes_count = 10;
  message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
  repeated Event events = 11; uint32 dropped_events_count = 12;
  message Link { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5; fixed32 flags = 6; }
  repeated Link links = 13; uint32 dropped_links_count = 14;
  Status status = 15;
}
message Status { string message = 2; int32 code = 3; }
`

const root = protobuf.parse(PROTO, { keepCase: true }).root
export const ExportTraceServiceRequest = root.lookupType('opentelemetry.proto.ExportTraceServiceRequest')

export function decode(bytes: Uint8Array): any {
  const msg = ExportTraceServiceRequest.decode(bytes)
  return ExportTraceServiceRequest.toObject(msg, { longs: String, bytes: String, defaults: false, oneofs: true })
}

/** Convert decoded KeyValue[] back to a plain object for assertions. */
export function kvToObject(kvs: any[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const kv of kvs) out[kv.key] = anyToJs(kv.value)
  return out
}

function anyToJs(v: any): unknown {
  if (!v) return undefined
  if ('string_value' in v) return v.string_value
  if ('bool_value' in v) return v.bool_value
  if ('int_value' in v) return Number(v.int_value)
  if ('double_value' in v) return { double: v.double_value }
  if ('array_value' in v) return (v.array_value.values ?? []).map(anyToJs)
  if ('kvlist_value' in v) return kvToObject(v.kvlist_value.values)
  return v
}
