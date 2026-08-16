/**
 * Salience-gated capture. Nothing is written automatically: when a
 * high-signal event fires (user correction/instruction, or a tool error just
 * overcome), the model gets one gentle plugin notice suggesting memory_write
 * — the model decides, so tool output never enters the store verbatim and
 * every memory is a distilled conclusion. Rate-limited per session.
 * @module dsh-code-memory/hooks/capture
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from '../config.js'
import type { MemoryStore } from '../store/store.js'
import { CAPTURE_NUDGE, DEBUG_NUDGE } from '../prompt.js'
import { freshUserText } from './shared.js'
import { trackAgents } from './agent-map.js'

/** User-input patterns that signal a durable correction or instruction. */
const SALIENCE_RE = /记住|记一下|以后|别再|不要再|不对[，,]|应该是|remember|always use|never use|don'?t use/iu

/** Minimum interval between nudges of any kind, per session. */
const NUDGE_INTERVAL_MS = 5 * 60 * 1000

export function registerCapture(ctx: Context, store: MemoryStore, config: ResolvedConfig): void {
  if (!config.capture.salienceGated) return
  const agents = trackAgents(ctx)
  const lastNudgeAt = new Map<Session, number>()
  const errorPending = new Map<Session, boolean>()

  const nudge = (session: Session, text: string): void => {
    const now = Date.now()
    const last = lastNudgeAt.get(session) ?? 0
    if (now - last < NUDGE_INTERVAL_MS) return
    lastNudgeAt.set(session, now)
    void store.toggles().then((toggles) => {
      if (!toggles.captureEnabled) return
      const agent: Agent | undefined = agents.get(session)
      agent?.inject(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-code-memory', form: 'notice', summary: '记忆捕获提示' },
      }))
    }).catch(() => undefined)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const text = freshUserText([event.data])
      if (text.length > 0 && SALIENCE_RE.test(text)) nudge(session, CAPTURE_NUDGE)
    } else if (event.type === 'tool/result') {
      if (event.data.error !== undefined) {
        errorPending.set(session, true)
      } else if (errorPending.get(session) === true) {
        errorPending.set(session, false)
        nudge(session, DEBUG_NUDGE)
      }
    } else if (event.type === 'turn/end') {
      errorPending.delete(session)
    }
  })

  ctx.on('session/disposed', (session) => {
    lastNudgeAt.delete(session)
    errorPending.delete(session)
  })
}
