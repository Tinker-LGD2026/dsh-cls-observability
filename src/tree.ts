/** Compact, id-free rendering of span trees (tests, diagnostics, e2e verification). */
import type { SpanRecord } from './otlp/types.ts'

export interface TreeNode {
  spanId: string
  parentSpanId?: string
  name: string
  start: bigint
  attributes: Record<string, unknown>
  statusError?: string
  events?: string[]
}

export function fromSpan(s: SpanRecord): TreeNode {
  return {
    spanId: s.spanId,
    ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
    name: s.name,
    start: s.startNs,
    attributes: s.attributes as Record<string, unknown>,
    ...(s.status?.code === 2 ? { statusError: s.status.message ?? '' } : {}),
    ...(s.events?.length ? { events: s.events.map((e) => e.name) } : {}),
  }
}

export function renderTree(nodes: TreeNode[], detail = false): string {
  const ids = new Set(nodes.map((n) => n.spanId))
  const byParent = new Map<string, TreeNode[]>()
  for (const n of nodes) {
    const key = n.parentSpanId && ids.has(n.parentSpanId) ? n.parentSpanId : 'root'
    byParent.set(key, [...(byParent.get(key) ?? []), n])
  }
  const lines: string[] = []
  const walk = (key: string, depth: number) => {
    const children = (byParent.get(key) ?? []).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name)))
    for (const n of children) {
      const a = n.attributes
      const kind = String(a['gen_ai.span.kind'])
      const extra = [
        a['gen_ai.response.finish_reasons'] ? `finish=${JSON.stringify(a['gen_ai.response.finish_reasons'])}` : '',
        a['gen_ai.usage.output_tokens'] !== undefined ? `out=${String(a['gen_ai.usage.output_tokens'])}` : '',
        detail && a['gen_ai.usage.input_tokens'] !== undefined ? `in=${String(a['gen_ai.usage.input_tokens'])}` : '',
        detail && a['gen_ai.response.time_to_first_token_ms'] !== undefined ? `ttft=${String(a['gen_ai.response.time_to_first_token_ms'])}ms` : '',
        detail && a['gen_ai.chat.duration_ms'] !== undefined ? `dur=${String(a['gen_ai.chat.duration_ms'])}ms` : '',
        detail && a['gen_ai.tool.call.duration_ms'] !== undefined ? `dur=${String(a['gen_ai.tool.call.duration_ms'])}ms` : '',
        a['agent.custom.trigger'] && kind === 'entry' ? `trigger=${String(a['agent.custom.trigger'])}` : '',
        a['agent.custom.turn_end_reason'] && kind === 'entry' ? `end=${String(a['agent.custom.turn_end_reason'])}` : '',
        a['agent.custom.llm_purpose'] ? `purpose=${String(a['agent.custom.llm_purpose'])}` : '',
        a['agent.custom.ptc_root_call_id'] ? 'ptc' : '',
        a['gen_ai.agent.scope'] === 'subagent' && kind === 'entry' ? 'subagent' : '',
        a['agent.custom.approval_outcome'] ? `approval=${String(a['agent.custom.approval_outcome'])}` : '',
        a['agent.custom.retry_index'] ? `retry#${String(a['agent.custom.retry_index'])}` : '',
        n.statusError !== undefined ? `ERROR(${n.statusError})` : '',
        n.events?.length ? `events=${n.events.join(',')}` : '',
      ].filter(Boolean).join(' ')
      lines.push(`${'  '.repeat(depth)}${kind} ${n.name}${extra ? `  [${extra}]` : ''}`)
      walk(n.spanId, depth + 1)
    }
  }
  walk('root', 0)
  return lines.join('\n')
}
