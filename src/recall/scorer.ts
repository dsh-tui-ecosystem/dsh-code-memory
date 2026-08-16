/**
 * Retrieval scoring — a simplified Generative Agents tri-factor:
 * `score = relevance × recency_decay + 0.2 × (importance / 5)`.
 * Recency decays on `lastConfirmed` with a 30-day time constant, so confirmed-
 * recently memories beat stale ones and importance alone cannot surface an
 * irrelevant memory (callers filter on relevance > 0).
 * @module dsh-code-memory/recall/scorer
 */
import type { Memory } from '../types.js'
import { keywordRelevance } from './keyword.js'

/** Recency half-life-ish time constant: e^-1 after 30 days unconfirmed. */
const RECENCY_TAU_DAYS = 30
const MS_PER_DAY = 86_400_000

export interface ScoredMemory {
  readonly memory: Memory
  readonly relevance: number
  readonly recency: number
  readonly importance: number
  readonly score: number
  /** True when every anchored path vanished from disk (score pre-penalized). */
  readonly stale?: boolean
}

/** Score one memory against pre-tokenized query terms. */
export function scoreMemory(queryTokens: readonly string[], memory: Memory, nowMs = Date.now()): ScoredMemory {
  const relevance = keywordRelevance(queryTokens, memory)
  const confirmedMs = Date.parse(memory.lastConfirmed)
  const ageDays = Number.isFinite(confirmedMs) ? Math.max(0, (nowMs - confirmedMs) / MS_PER_DAY) : 365
  const recency = Math.exp(-ageDays / RECENCY_TAU_DAYS)
  const importance = memory.importance / 5
  return {
    memory,
    relevance,
    recency,
    importance,
    score: relevance * recency + 0.2 * importance,
  }
}

/** Score, filter (relevance > 0, active only), and rank a candidate set. */
export function rankMemories(
  memories: readonly Memory[],
  queryTokens: readonly string[],
  nowMs = Date.now(),
): ScoredMemory[] {
  return memories
    .filter((memory) => memory.status === 'active')
    .map((memory) => scoreMemory(queryTokens, memory, nowMs))
    .filter((scored) => scored.relevance > 0)
    .sort((a, b) => b.score - a.score)
}
