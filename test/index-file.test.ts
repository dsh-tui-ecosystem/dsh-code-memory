import { describe, expect, it } from 'vitest'
import { buildIndex, summarize } from '../src/store/index-file.js'
import type { Memory } from '../src/types.js'

function mem(overrides: Partial<Memory> & { id: string }): Memory {
  return {
    type: 'fact',
    scope: 'project',
    source: 'user',
    importance: 3,
    created: '2026-08-01T00:00:00.000Z',
    lastConfirmed: '2026-08-10T00:00:00.000Z',
    status: 'active',
    tags: [],
    body: `内容 ${overrides.id}`,
    file: `facts/${overrides.id}.md`,
    ...overrides,
  }
}

describe('index-file', () => {
  it('summarize takes the first non-empty line, truncated', () => {
    const memory = mem({ id: 'mem_A', body: '\n\n第一行内容。\n第二行。' })
    expect(summarize(memory)).toBe('第一行内容。')
    expect(summarize(mem({ id: 'mem_B', body: 'x'.repeat(200) }), 80).length).toBe(80)
  })

  it('excludes superseded memories and orders by importance then recency', () => {
    const index = buildIndex([
      mem({ id: 'mem_old', importance: 2 }),
      mem({ id: 'mem_new', importance: 5, lastConfirmed: '2026-08-16T00:00:00.000Z' }),
      mem({ id: 'mem_dead', status: 'superseded' }),
    ], 1200, 'project')
    expect(index).toContain('mem_new')
    expect(index).toContain('mem_old')
    expect(index).not.toContain('mem_dead')
    expect(index.indexOf('mem_new')).toBeLessThan(index.indexOf('mem_old'))
  })

  it('folds overflow with an explicit notice instead of dropping silently', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      mem({ id: `mem_${String(i).padStart(3, '0')}`, body: `条目 ${i} ${'长'.repeat(40)}` }))
    // 50 条 × ~80 字符 ≈ 4000+ 字符 ≈ 1000 token；预算 50 token 必然折叠
    const index = buildIndex(many, 50, 'project')
    expect(index).toMatch(/已折叠 \d+ 条/)
    expect(index).toContain('memory_search')
  })

  it('renders an empty state', () => {
    expect(buildIndex([], 1200, 'global')).toContain('暂无记忆')
  })
})
