/**
 * Prompt-time recall: the `agent/pre-step` waterfall. When a step carries
 * fresh user input, the query is scored against the memory files and the
 * top-K (budget-fitted) entries are appended as a `form:'recall'` plugin
 * message. No hits, recall off, or no user input → `next()` (untouched).
 * All work is local disk + string scoring: no network, no LLM calls.
 * @module dsh-code-memory/hooks/pre-step
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves the agent/* cordis event declarations.
import type {} from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from '../config.js'
import type { MemoryStore } from '../store/store.js'
import type { RecallTracker } from '../recall/tracker.js'
import { renderRecall } from '../recall/render.js'
import { emitRecalled, freshUserText } from './shared.js'

export function registerPreStepRecall(ctx: Context, store: MemoryStore, config: ResolvedConfig, tracker?: RecallTracker): void {
  if (!config.recall.onPreStep) return
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const query = freshUserText(messages)
    if (query.length === 0) return next()

    const toggles = await store.toggles()
    if (!toggles.recallEnabled) return next()

    const cwd = agent.session.header.cwd ?? process.cwd()
    const ranked = store.search(query, cwd).slice(0, config.recall.topK)
    if (ranked.length === 0) return next()

    const rendered = renderRecall(ranked, config.recall.maxTokens)
    if (rendered.injected.length === 0) return next()

    const recallMessage = createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: { kind: 'plugin', plugin: 'dsh-code-memory', form: 'recall' },
    })
    const ids = rendered.injected.map((scored) => scored.memory.id)
    tracker?.record(agent.session, ids, 'pre-step')
    emitRecalled(agent.session, {
      via: 'pre-step',
      ids,
      query: query.slice(0, 200),
      budgetTokens: config.recall.maxTokens,
      folded: rendered.folded,
    })
    return { kind: 'enter', messages: [...messages, recallMessage] }
  })
}
