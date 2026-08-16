/**
 * Consolidation report — the first step of the consolidation pipeline
 * (importance/merge/decay/eviction, cf. docs/improvements-2026-08.md).
 * Report-only by design: it surfaces actionable candidates and the model or
 * user executes via supersede/rm — no automatic mutation, no LLM calls.
 *
 * Three detector classes, each mapping to a known rot mode:
 *  - near-duplicates: the same fact written twice (merge candidates)
 *  - stale anchors: every referenced path vanished from disk (refactor rot)
 *  - ancient & low-importance: unconfirmed for 90+ days (quiet irrelevance)
 * @module dsh-code-memory/store/compact
 */
import { tokenize } from '../recall/keyword.js'
import { pathsStale } from '../recall/staleness.js'
import type { Memory } from '../types.js'
import type { MemoryStore } from './store.js'

export interface NearDupPair {
  readonly a: Memory
  readonly b: Memory
  /** Body-token containment similarity in [0, 1] (see bodyContainment). */
  readonly similarity: number
}

export interface CompactReport {
  /** Active same-scope pairs that look like the same memory written twice. */
  readonly nearDupPairs: readonly NearDupPair[]
  /** Active memories whose anchored paths all vanished from disk. */
  readonly stale: readonly Memory[]
  /** Active memories unconfirmed for 90+ days with importance ≤ 2. */
  readonly ancient: readonly Memory[]
}

/** Body-token containment at or above which two memories are near-duplicates. */
const NEAR_DUP_SIMILARITY = 0.8
/** With a shared curated tag, a weaker containment already suggests a dup. */
const TAG_OVERLAP_MIN_SIMILARITY = 0.6
const ANCIENT_AGE_DAYS = 90
const ANCIENT_MAX_IMPORTANCE = 2
const MS_PER_DAY = 86_400_000

/**
 * Duplicate-detection similarity: |A∩B| / min(|A|, |B|) over body token sets.
 * Containment (not Jaccard) because the shorter of two near-identical bodies
 * should score ~1.0 — "same fact, one with extra detail" is exactly the
 * merge candidate this detector exists for. Deliberately NOT keywordRelevance:
 * its body-only ceiling (0.5) can never reach the duplicate threshold, so
 * exact duplicates without tags would evade detection.
 */
export function bodyContainment(a: Memory, b: Memory): number {
  const aTokens = new Set(tokenize(a.body))
  const bTokens = new Set(tokenize(b.body))
  const smaller = Math.min(aTokens.size, bTokens.size)
  if (smaller === 0) return 0
  let overlap = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1
  }
  return overlap / smaller
}

export function buildCompactReport(store: MemoryStore, cwd: string, nowMs = Date.now()): CompactReport {
  const { memories } = store.list(cwd) // active only
  const byScope = new Map<string, Memory[]>()
  for (const memory of memories) {
    const group = byScope.get(memory.scope) ?? []
    group.push(memory)
    byScope.set(memory.scope, group)
  }

  const nearDupPairs: NearDupPair[] = []
  for (const group of byScope.values()) {
    for (let i = 0; i < group.length; i += 1) {
      const a = group[i]
      if (a === undefined) continue
      const aTags = new Set(a.tags.map((tag) => tag.toLowerCase()))
      for (let j = i + 1; j < group.length; j += 1) {
        const b = group[j]
        if (b === undefined) continue
        const similarity = bodyContainment(a, b)
        if (similarity >= NEAR_DUP_SIMILARITY) {
          nearDupPairs.push({ a, b, similarity })
          continue
        }
        const tagOverlap = b.tags.some((tag) => aTags.has(tag.toLowerCase()))
        if (tagOverlap && similarity >= TAG_OVERLAP_MIN_SIMILARITY) {
          nearDupPairs.push({ a, b, similarity })
        }
      }
    }
  }

  const stale = memories.filter((memory) => pathsStale(memory, cwd))
  const ancient = memories.filter((memory) => {
    if (memory.importance > ANCIENT_MAX_IMPORTANCE) return false
    const confirmedMs = Date.parse(memory.lastConfirmed)
    if (!Number.isFinite(confirmedMs)) return true
    return (nowMs - confirmedMs) / MS_PER_DAY > ANCIENT_AGE_DAYS
  })

  return { nearDupPairs, stale, ancient }
}
