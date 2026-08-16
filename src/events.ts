/**
 * `memory/*` session events — log-only, non-surface observability records
 * published by this plugin. They never enter derived model history (no
 * surface intent), so they cannot leak into prompts; they exist so UIs and
 * diagnostics can trace what the memory layer did and why.
 * @module dsh-code-memory/events
 */

/** Durable payload of one `memory/captured` event (a memory was written). */
export interface MemoryCapturedEvent {
  /** Memory id (mem_<ulid>). */
  readonly id: string
  /** Memory type: fact | episode | procedure. */
  readonly type: string
  /** Scope the memory was written to: global | project. */
  readonly scope: string
  /** Trust provenance: user | agent-inferred | tool-output. */
  readonly source: string
  /** Markdown file path relative to the scope memory dir. */
  readonly file: string
}

/** Durable payload of one `memory/recalled` event (memories were injected). */
export interface MemoryRecalledEvent {
  /** Injection channel that fired. */
  readonly via: 'session-start' | 'pre-step'
  /** Recalled memory ids, in injected order. */
  readonly ids: readonly string[]
  /** The query text that drove pre-step recall, when any. */
  readonly query?: string
  /** Approximate token budget the injection was fitted into. */
  readonly budgetTokens: number
  /** How many scored candidates were folded away by the budget. */
  readonly folded: number
}

/** Durable payload of one `memory/superseded` event (conflict resolution). */
export interface MemorySupersededEvent {
  /** The memory that lost (now status: superseded). */
  readonly oldId: string
  /** The memory that replaced it. */
  readonly newId: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Log-only record that a memory file was written. Never a surface event:
     * UIs may render it, the model never sees it.
     * @param data - The written memory's coordinates.
     */
    'memory/captured': MemoryCapturedEvent
    /**
     * Log-only record that memories were recalled into the model context.
     * @param data - Channel, ids, and budget bookkeeping.
     */
    'memory/recalled': MemoryRecalledEvent
    /**
     * Log-only record that a memory was superseded by a newer one.
     * @param data - Old and new memory ids.
     */
    'memory/superseded': MemorySupersededEvent
  }
}
