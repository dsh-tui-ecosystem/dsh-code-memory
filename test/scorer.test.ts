import { describe, expect, it } from 'vitest'
import { tokenize } from '../src/recall/keyword.js'
import { rankMemories, scoreMemory } from '../src/recall/scorer.js'
import type { Memory } from '../src/types.js'

const NOW = Date.parse('2026-08-17T00:00:00.000Z')

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
    body: '',
    file: 'facts/x.md',
    ...overrides,
  }
}

describe('tokenize', () => {
  it('splits latin words and CJK bigrams', () => {
    expect(tokenize('use pnpm install')).toEqual(['use', 'pnpm', 'install'])
    expect(tokenize('构建命令')).toEqual(['构建', '建命', '命令'])
    expect(tokenize('短')).toEqual(['短'])
  })
})

describe('scorer', () => {
  it('ranks relevant memories above irrelevant ones regardless of importance', () => {
    const relevant = mem({ id: 'mem_rel', body: '本仓库必须用 pnpm 构建', importance: 1 })
    const irrelevant = mem({ id: 'mem_irr', body: '完全不相关的部署笔记', importance: 5 })
    const ranked = rankMemories([relevant, irrelevant], tokenize('pnpm 构建'), NOW)
    expect(ranked.map((scored) => scored.memory.id)).toEqual(['mem_rel'])
  })

  it('decays stale memories below freshly confirmed ones at equal relevance', () => {
    const fresh = mem({ id: 'mem_fresh', body: '构建 命令 pnpm', lastConfirmed: '2026-08-16T00:00:00.000Z' })
    const stale = mem({ id: 'mem_stale', body: '构建 命令 pnpm', lastConfirmed: '2026-01-01T00:00:00.000Z' })
    const ranked = rankMemories([stale, fresh], tokenize('pnpm'), NOW)
    expect(ranked[0]?.memory.id).toBe('mem_fresh')
  })

  it('excludes superseded memories', () => {
    const dead = mem({ id: 'mem_dead', body: 'pnpm 构建', status: 'superseded' })
    expect(rankMemories([dead], tokenize('pnpm'), NOW)).toEqual([])
  })

  it('weights tag hits above body hits', () => {
    const tagged = mem({ id: 'mem_tag', body: '无关正文', tags: ['pnpm'] })
    const bodied = mem({ id: 'mem_body', body: '提到一次 pnpm 而已' })
    const taggedScore = scoreMemory(tokenize('pnpm'), tagged, NOW)
    const bodiedScore = scoreMemory(tokenize('pnpm'), bodied, NOW)
    expect(taggedScore.relevance).toBeGreaterThan(bodiedScore.relevance)
  })
})
