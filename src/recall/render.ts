/**
 * Recall rendering — turns ranked memories into the injected text block.
 * Progressive disclosure: short bodies inline, long bodies truncated with a
 * pointer (id + file) so the model can pull the full text via memory_get.
 * Provenance (scope/type/source/date) rides every entry so the model can
 * judge freshness and trust. Hard budget: overflow is folded into an
 * explicit count, never silently dropped.
 * @module dsh-code-memory/recall/render
 */
import type { ScoredMemory } from './scorer.js'

const CHARS_PER_TOKEN = 4
/** Bodies longer than this collapse to summary + pointer. */
const INLINE_BODY_MAX = 600

export interface RenderedRecall {
  readonly text: string
  readonly injected: ScoredMemory[]
  readonly folded: number
}

export function renderRecall(ranked: readonly ScoredMemory[], maxTokens: number): RenderedRecall {
  const header = '<memory-recall source="dsh-code-memory">\n以下记忆与当前输入相关（已标注来源与确认日期，时效与可信度请自行判断；完整内容可用 memory_get 按 id 取）：\n'
  const budget = maxTokens * CHARS_PER_TOKEN
  let used = header.length
  const lines: string[] = []
  const injected: ScoredMemory[] = []
  let folded = 0
  for (const scored of ranked) {
    const memory = scored.memory
    const date = memory.lastConfirmed.slice(0, 10)
    const stale = scored.stale === true ? ' · ⚠引用路径已失效，请先核实' : ''
    const body = memory.body.length > INLINE_BODY_MAX
      ? `${memory.body.slice(0, INLINE_BODY_MAX)}…（余下 ${memory.body.length - INLINE_BODY_MAX} 字符，用 memory_get ${memory.id} 取全文）`
      : memory.body
    const entry = `\n[${memory.scope}/${memory.type} · ${memory.source} · ${date}${stale} · id=${memory.id}]\n${body}\n`
    if (used + entry.length > budget && injected.length > 0) {
      folded += 1
      continue
    }
    lines.push(entry)
    injected.push(scored)
    used += entry.length
  }
  const foldNote = folded > 0 ? `\n（另有 ${folded} 条相关记忆受预算限制未注入，可用 memory_search 查询。）\n` : ''
  return { text: `${header}${lines.join('')}${foldNote}</memory-recall>`, injected, folded }
}
