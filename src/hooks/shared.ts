/**
 * Shared helpers for the recall hooks: text extraction from user messages
 * and log-only `memory/recalled` event appends.
 * @module dsh-code-memory/hooks/shared
 */
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { MemoryRecalledEvent } from '../events.js'

/**
 * Concatenate the text blocks of messages that carry FRESH user input only
 * (source kind `user`). Tool results (kind `tool`) and our own recall/plugin
 * messages are deliberately excluded — recalling on them would feed the
 * memory layer its own output (bootstrap poisoning).
 */
export function freshUserText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Append a log-only `memory/recalled` event. Never throws, never blocks:
 * the append is deferred to a microtask because some dispatch paths hold the
 * session's appending guard while listeners run.
 */
export function emitRecalled(session: Session, event: MemoryRecalledEvent): void {
  queueMicrotask(() => {
    try {
      session.append('memory/recalled', event)
    } catch {
      // Session closed or guard held: observability is best-effort.
    }
  })
}
