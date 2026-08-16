/**
 * Compaction rescue: when compaction begins, nudge the model to write the
 * durable parts of the working context (architecture decisions, open
 * issues, progress) into memory BEFORE the summary swallows them.
 * @module dsh-code-memory/hooks/compaction
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: merges the compaction/* session event types into SessionEventMap.
import type {} from '@deepseek-ai/dsh-compaction'
import type { ResolvedConfig } from '../config.js'
import type { MemoryStore } from '../store/store.js'
import { COMPACTION_NUDGE } from '../prompt.js'
import { trackAgents } from './agent-map.js'

export function registerCompactionRescue(ctx: Context, store: MemoryStore, config: ResolvedConfig): void {
  if (!config.capture.compactionRescue) return
  const agents = trackAgents(ctx)

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/start') return
    void store.toggles().then((toggles) => {
      if (!toggles.captureEnabled) return
      agents.get(session)?.inject(createUserMessage({
        content: [{ type: 'text', text: COMPACTION_NUDGE }],
        source: { kind: 'plugin', plugin: 'dsh-code-memory', form: 'notice', summary: '压缩前记忆抢救' },
      }))
    }).catch(() => undefined)
  })
}
