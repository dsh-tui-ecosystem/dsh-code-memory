/**
 * Session-start recall: inject the MEMORY.md index of every enabled scope
 * (global first, project last so nearer context wins) when a session begins
 * — startup, resume, clear, and compact alike, so the memory index survives
 * compaction. Nothing is injected when no index exists or recall is off.
 * @module dsh-code-memory/hooks/session-start
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: resolves the agent/* cordis event declarations.
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from '../config.js'
import type { MemoryStore } from '../store/store.js'
import { emitRecalled } from './shared.js'

const MEMORY_ID_LIST_RE = /mem_[0-9A-HJKMNP-TV-Z]{26}/gu

export function registerSessionStartRecall(ctx: Context, store: MemoryStore, config: ResolvedConfig): void {
  if (!config.recall.onSessionStart) return
  ctx.on('agent/session-start', ({ agent, source }) => {
    void injectIndex(agent, source, store, config).catch(() => {
      // Recall is best-effort; a disk hiccup must not break session startup.
    })
  })
}

async function injectIndex(
  agent: Agent,
  source: string,
  store: MemoryStore,
  config: ResolvedConfig,
): Promise<void> {
  const toggles = await store.toggles()
  if (!toggles.recallEnabled) return
  const cwd = agent.session.header.cwd ?? process.cwd()
  const scopes: ('global' | 'project')[] = []
  if (config.scopes.global) scopes.push('global')
  if (config.scopes.project) scopes.push('project')

  const sections: string[] = []
  for (const scope of scopes) {
    const dir = scope === 'global' ? store.globalDir() : store.projectDir(cwd)
    const indexPath = join(dir, 'MEMORY.md')
    if (!existsSync(indexPath)) continue
    const content = readFileSync(indexPath, 'utf8').trim()
    if (content.length === 0 || content.includes('暂无记忆')) continue
    sections.push(`## ${scope}\n${content}`)
  }
  if (sections.length === 0) return

  const text = [
    `<memory-index source="dsh-code-memory" trigger="${source}">`,
    '持久记忆索引（每行：id、文件、一行摘要）。与当前任务相关的条目可用 memory_get 取全文，memory_search 检索更多；不要凭索引行臆断细节。',
    '',
    sections.join('\n\n'),
    '</memory-index>',
  ].join('\n')

  agent.inject(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-code-memory', form: 'recall' },
  }))
  emitRecalled(agent.session, {
    via: 'session-start',
    ids: text.match(MEMORY_ID_LIST_RE) ?? [],
    budgetTokens: config.recall.maxTokens,
    folded: 0,
  })
}
