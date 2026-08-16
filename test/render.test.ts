import { describe, expect, it } from 'vitest'
import { renderRecall } from '../src/recall/render.js'
import type { ScoredMemory } from '../src/recall/scorer.js'
import type { Memory } from '../src/types.js'

function scored(id: string, body: string, overrides: Partial<Memory> = {}): ScoredMemory {
  const memory: Memory = {
    id,
    type: 'fact',
    scope: 'project',
    source: 'user',
    importance: 3,
    created: '2026-08-01T00:00:00.000Z',
    lastConfirmed: '2026-08-10T00:00:00.000Z',
    status: 'active',
    tags: [],
    body,
    file: `facts/${id}.md`,
    ...overrides,
  }
  return { memory, relevance: 0.8, recency: 0.9, importance: 0.6, score: 0.8 }
}

describe('renderRecall', () => {
  it('inlines short bodies with provenance and id', () => {
    const { text, injected, folded } = renderRecall([scored('mem_01JZKAAAAAAAAAAAAAAAAAAAAA', '构建命令是 pnpm build')], 1200)
    expect(text).toContain('<memory-recall')
    expect(text).toContain('构建命令是 pnpm build')
    expect(text).toContain('project/fact · user · 2026-08-10')
    expect(injected.length).toBe(1)
    expect(folded).toBe(0)
  })

  it('truncates long bodies with a memory_get pointer', () => {
    const long = 'x'.repeat(1000)
    const { text } = renderRecall([scored('mem_01JZKAAAAAAAAAAAAAAAAAAAAA', long)], 1200)
    expect(text).toContain('memory_get mem_01JZKAAAAAAAAAAAAAAAAAAAAA')
    expect(text).not.toContain(long)
  })

  it('folds overflow within budget, always keeping at least one entry', () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      scored(`mem_01JZK${String(i)}${'A'.repeat(20)}`, `条目 ${i} ${'长'.repeat(100)}`))
    const { text, injected, folded } = renderRecall(entries, 100)
    expect(injected.length).toBeGreaterThan(0)
    expect(injected.length).toBeLessThan(8)
    expect(folded).toBe(8 - injected.length)
    expect(text).toContain(`另有 ${folded} 条`)
    expect(text).toContain('memory_search')
  })
})
