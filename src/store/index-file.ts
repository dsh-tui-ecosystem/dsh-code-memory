/**
 * MEMORY.md index generation — the always-injected, curated entry point.
 * Active memories only, one line each (pointer + summary + provenance), best
 * first; a hard token budget folds the tail into an explicit "N more"
 * notice rather than silently dropping entries.
 * @module dsh-code-memory/store/index-file
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Memory } from '../types.js'

/** Rough heuristic: ~4 chars per token for mixed zh/en technical text. */
const CHARS_PER_TOKEN = 4

/** One-line summary: first non-empty body line, hard-truncated. */
export function summarize(memory: Memory, maxChars = 80): string {
  const firstLine = memory.body.split('\n').find((line) => line.trim().length > 0) ?? ''
  const clean = firstLine.replace(/\s+/gu, ' ').trim()
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean
}

function indexLine(memory: Memory): string {
  const date = memory.lastConfirmed.slice(0, 10)
  return `- [${memory.id}](${memory.file}) — ${summarize(memory)} _(${memory.type}, ${memory.source}, ${date})_`
}

/**
 * Build the MEMORY.md content for one scope. Entries are ordered by
 * importance then recency; everything past the budget is folded into a
 * trailing notice naming the overflow count.
 */
export function buildIndex(memories: readonly Memory[], maxTokens: number, scopeLabel: string): string {
  const active = memories
    .filter((memory) => memory.status === 'active')
    .sort((a, b) => (b.importance - a.importance) || b.lastConfirmed.localeCompare(a.lastConfirmed))
  const header = `# Memory Index (${scopeLabel})\n\n`
  const budget = maxTokens * CHARS_PER_TOKEN
  const lines: string[] = []
  let used = header.length
  let folded = 0
  for (const memory of active) {
    const line = indexLine(memory)
    if (used + line.length + 1 > budget) {
      folded += 1
      continue
    }
    lines.push(line)
    used += line.length + 1
  }
  const foldNote = folded > 0 ? `\n_已折叠 ${folded} 条低优先级记忆，用 memory_search 或 /memory search 查询。_\n` : ''
  if (lines.length === 0 && folded === 0) return `${header}_（暂无记忆）_\n`
  return `${header}${lines.join('\n')}\n${foldNote}`
}

/** Regenerate MEMORY.md inside one scope dir. Returns the written content. */
export function writeIndex(dir: string, memories: readonly Memory[], maxTokens: number, scopeLabel: string): string {
  const content = buildIndex(memories, maxTokens, scopeLabel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), content, 'utf8')
  return content
}
