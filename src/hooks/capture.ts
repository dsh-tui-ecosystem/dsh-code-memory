/**
 * Salience-gated capture + error-triggered recall. Nothing is written
 * automatically: when a high-signal event fires (user correction/instruction,
 * or a tool error just overcome), the model gets one gentle plugin notice
 * suggesting memory_write — the model decides, so tool output never enters
 * the store verbatim and every memory is a distilled conclusion.
 *
 * Error recall is the inverse flow: when a tool result carries an error, the
 * error text is searched against the store and any strong hit ("we have seen
 * this failure before") is injected immediately — the highest-value moment
 * for a procedure memory is the moment the error reappears.
 * Both flows are rate-limited per session.
 * @module dsh-code-memory/hooks/capture
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from '../config.js'
import type { MemoryStore } from '../store/store.js'
import type { RecallTracker } from '../recall/tracker.js'
import { renderRecall } from '../recall/render.js'
import { CAPTURE_NUDGE, DEBUG_NUDGE } from '../prompt.js'
import { emitRecalled, freshUserText } from './shared.js'
import { trackAgents } from './agent-map.js'

/** User-input patterns that signal a durable correction or instruction. */
const SALIENCE_RE = /记住|记一下|以后|别再|不要再|不对[，,]|应该是|remember|always use|never use|don'?t use/iu

/** Minimum interval between nudges of any kind, per session. */
const NUDGE_INTERVAL_MS = 5 * 60 * 1000

/** Minimum interval between error-recall injections, per session. */
const ERROR_RECALL_INTERVAL_MS = 5 * 60 * 1000

/** Minimum relevance for an error-text search hit to be worth injecting. */
const ERROR_RECALL_MIN_RELEVANCE = 0.4

/** Error recall rides a smaller budget than interactive recall. */
const ERROR_RECALL_MAX_TOKENS = 400

/** The tool/result payload fields error recall reads (mirrors dsh-session's event type). */
interface ToolResultData {
  readonly message: {
    readonly content: readonly {
      readonly type: string
      readonly text?: string
      readonly content?: readonly { readonly type: string; readonly text?: string }[]
    }[]
  }
  readonly error?: { readonly name: string; readonly code: string }
}

/**
 * Build the recall query from a failed tool result. The model-facing
 * diagnostic lives in the result message's text blocks (e.g. "TS2307: Cannot
 * find module ..."); `error` is only the internal identity {name, code} and
 * is appended as a hint, never used alone.
 */
export function toolErrorQuery(data: ToolResultData): string {
  const parts: string[] = []
  for (const block of data.message.content) {
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner.type === 'text' && inner.text !== undefined) parts.push(inner.text)
      }
    } else if (block.type === 'text' && block.text !== undefined) {
      parts.push(block.text)
    }
  }
  if (data.error !== undefined) parts.push(`${data.error.name} ${data.error.code}`)
  return parts.join('\n').trim().slice(0, 500)
}

export function registerCapture(ctx: Context, store: MemoryStore, config: ResolvedConfig, tracker?: RecallTracker): void {
  if (!config.capture.salienceGated) return
  const agents = trackAgents(ctx)
  const lastNudgeAt = new Map<Session, number>()
  const lastErrorRecallAt = new Map<Session, number>()
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

  const recallOnError = (session: Session, data: ToolResultData): void => {
    const query = toolErrorQuery(data)
    if (query.length === 0) return
    const now = Date.now()
    const last = lastErrorRecallAt.get(session) ?? 0
    if (now - last < ERROR_RECALL_INTERVAL_MS) return
    // Reserve the interval synchronously: the toggles await below yields, and
    // parallel tool failures would otherwise each read the stale timestamp
    // and all inject despite the rate limit. The reservation is an IN-FLIGHT
    // marker, not a record of injection — every exit path that never injected
    // must release it, or a recall-disabled/no-hit/agent-less error would
    // throttle a later error that did have a valid hit.
    lastErrorRecallAt.set(session, now)
    const release = (): void => {
      // Only release our own reservation; a newer one may already exist.
      if (lastErrorRecallAt.get(session) === now) lastErrorRecallAt.delete(session)
    }
    void store.toggles().then((toggles) => {
      if (!toggles.recallEnabled) return release()
      const cwd = session.header.cwd ?? process.cwd()
      const hits = store.search(query, cwd)
        .filter((scored) => scored.relevance >= ERROR_RECALL_MIN_RELEVANCE)
        .slice(0, 2)
      if (hits.length === 0) return release()
      const agent: Agent | undefined = agents.get(session)
      if (agent === undefined) return release()
      const rendered = renderRecall(hits, ERROR_RECALL_MAX_TOKENS)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: rendered.text }],
        source: { kind: 'plugin', plugin: 'dsh-code-memory', form: 'recall', summary: '错误相关记忆' },
      }))
      const ids = rendered.injected.map((scored) => scored.memory.id)
      tracker?.record(session, ids, 'on-error')
      emitRecalled(session, {
        via: 'on-error',
        ids,
        query: query.slice(0, 200),
        budgetTokens: ERROR_RECALL_MAX_TOKENS,
        folded: rendered.folded,
      })
    }).catch(() => {
      // Search/toggles threw before any injection: release the reservation.
      release()
    })
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      const text = freshUserText([event.data])
      if (text.length > 0 && SALIENCE_RE.test(text)) nudge(session, CAPTURE_NUDGE)
    } else if (event.type === 'tool/result') {
      if (event.data.error !== undefined) {
        errorPending.set(session, true)
        recallOnError(session, event.data)
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
    lastErrorRecallAt.delete(session)
    errorPending.delete(session)
  })
}
