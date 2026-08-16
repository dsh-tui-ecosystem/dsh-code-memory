import { describe, expect, it } from 'vitest'
import { parseMemory, serializeMemory } from '../src/store/frontmatter.js'
import { memoryFrontmatterSchema } from '../src/types.js'
import type { MemoryFrontmatter } from '../src/types.js'

const VALID_ID = `mem_01JZK${'A'.repeat(21)}` // 26 位 Crockford base32

const SAMPLE: MemoryFrontmatter = memoryFrontmatterSchema.parse({
  id: VALID_ID,
  type: 'procedure',
  scope: 'project',
  source: 'user',
  importance: 4,
  created: '2026-08-17T02:00:00.000Z',
  lastConfirmed: '2026-08-17T02:00:00.000Z',
  status: 'active',
  tags: ['build', 'pnpm'],
})

describe('frontmatter', () => {
  it('round-trips serialize → parse', () => {
    const raw = serializeMemory(SAMPLE, '本仓库必须用 pnpm。\n\n第二行。')
    const parsed = parseMemory(raw, 'procedures/test.md')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.memory.id).toBe(SAMPLE.id)
    expect(parsed.memory.tags).toEqual(['build', 'pnpm'])
    expect(parsed.memory.body).toBe('本仓库必须用 pnpm。\n\n第二行。')
    expect(parsed.memory.file).toBe('procedures/test.md')
  })

  it('round-trips optional supersededBy', () => {
    const raw = serializeMemory(
      { ...SAMPLE, status: 'superseded', supersededBy: VALID_ID },
      '旧事实。',
    )
    const parsed = parseMemory(raw, 'facts/old.md')
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.memory.status).toBe('superseded')
      expect(parsed.memory.supersededBy).toBe(VALID_ID)
    }
  })

  it('rejects missing frontmatter without throwing', () => {
    const parsed = parseMemory('没有 frontmatter 的正文', 'facts/bad.md')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('frontmatter')
  })

  it('rejects schema violations (bad id) without throwing', () => {
    const raw = serializeMemory(SAMPLE, 'x').replace(SAMPLE.id, 'not-a-valid-id')
    const parsed = parseMemory(raw, 'facts/bad-id.md')
    expect(parsed.ok).toBe(false)
  })

  it('rejects broken YAML without throwing', () => {
    const parsed = parseMemory('---\n: : not yaml\n---\nbody', 'facts/bad-yaml.md')
    expect(parsed.ok).toBe(false)
  })
})
