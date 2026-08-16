/**
 * RecallTracker — in-process record of which memories were recalled into
 * which session, and via which channel. When the model later pulls one of
 * those memories in full (memory_get), that follow-up is the recall-quality
 * feedback signal, logged as `memory/recall-used`. Entries expire after a
 * short TTL: a get hours later is a fresh search hit, not a recall follow-up.
 * @module dsh-code-memory/recall/tracker
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MemoryRecalledEvent } from '../events.js'

type Via = MemoryRecalledEvent['via']

interface RecalledEntry {
  readonly at: number
  readonly via: Via
}

/** How long a recalled id counts as "recently recalled" for follow-up attribution. */
const RECALL_TTL_MS = 30 * 60 * 1000

export class RecallTracker {
  private readonly bySession = new Map<Session, Map<string, RecalledEntry>>()

  /** Drop per-session state when sessions go away. */
  attach(ctx: Context): void {
    ctx.on('session/disposed', (session) => {
      this.bySession.delete(session)
    })
  }

  /** Record that these memories were injected into this session. */
  record(session: Session, ids: readonly string[], via: Via, nowMs = Date.now()): void {
    if (ids.length === 0) return
    let entries = this.bySession.get(session)
    if (entries === undefined) {
      entries = new Map()
      this.bySession.set(session, entries)
    }
    for (const id of ids) entries.set(id, { at: nowMs, via })
  }

  /** The channel that recalled `id` within the TTL, if any. Lazy expiry. */
  lookup(session: Session | undefined, id: string, nowMs = Date.now()): Via | undefined {
    if (session === undefined) return undefined
    const entries = this.bySession.get(session)
    if (entries === undefined) return undefined
    for (const [key, entry] of entries) {
      if (nowMs - entry.at > RECALL_TTL_MS) entries.delete(key)
    }
    return entries.get(id)?.via
  }
}
