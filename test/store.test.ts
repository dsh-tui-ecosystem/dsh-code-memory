import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/store.js'
import { resolveConfig } from '../src/config.js'

let root: string
let cwd: string
let store: MemoryStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mem-'))
  cwd = join(root, 'repo')
  mkdirSync(cwd, { recursive: true })
  process.env.DSH_HOME = join(root, 'dsh-home')
  store = new MemoryStore(resolveConfig({}))
  store.detachDomain() // 文件-only 模式：domain 永不 attach，toggles 走默认值
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(root, { recursive: true, force: true })
})

describe('MemoryStore (file-only)', () => {
  it('add writes a project-scope file and refreshes MEMORY.md', () => {
    const result = store.add({ content: '本仓库必须用 pnpm。', type: 'procedure', scope: 'project', source: 'user', tags: ['build'] }, cwd)
    expect(result.memory.id).toMatch(/^mem_/)
    const file = readFileSync(join(cwd, '.dsh/memory', result.memory.file), 'utf8')
    expect(file).toContain('本仓库必须用 pnpm。')
    const index = readFileSync(join(cwd, '.dsh/memory/MEMORY.md'), 'utf8')
    expect(index).toContain(result.memory.id)
  })

  it('add truncates over-long bodies and reports it', () => {
    const result = store.add({ content: 'x'.repeat(5000), type: 'fact', scope: 'project', source: 'user' }, cwd)
    expect(result.truncated).toBe(true)
    expect(result.memory.body.length).toBe(2000)
  })

  it('list/get/remove round-trip across scopes', () => {
    const a = store.add({ content: '项目级事实', type: 'fact', scope: 'project', source: 'user' }, cwd)
    const g = store.add({ content: '全局偏好：回复用中文', type: 'fact', scope: 'global', source: 'user' }, cwd)
    expect(store.list(cwd).memories.map((m) => m.id).sort()).toEqual([a.memory.id, g.memory.id].sort())
    expect(store.list(cwd, { scope: 'global' }).memories.map((m) => m.id)).toEqual([g.memory.id])
    expect(store.get(a.memory.id, cwd)?.body).toBe('项目级事实')
    expect(store.remove(a.memory.id, cwd)?.id).toBe(a.memory.id)
    expect(store.get(a.memory.id, cwd)).toBeUndefined()
    // 索引同步移除
    expect(readFileSync(join(cwd, '.dsh/memory/MEMORY.md'), 'utf8')).not.toContain(a.memory.id)
  })

  it('add surfaces tag-overlap conflicts', () => {
    store.add({ content: '测试命令是 pnpm vitest', type: 'procedure', scope: 'project', source: 'user', tags: ['test'] }, cwd)
    const second = store.add({ content: '测试要先 build', type: 'procedure', scope: 'project', source: 'user', tags: ['test'] }, cwd)
    expect(second.conflicts.length).toBe(1)
  })

  it('malformed files are skipped with warnings, listing still works', () => {
    store.add({ content: '正常记忆', type: 'fact', scope: 'project', source: 'user' }, cwd)
    writeFileSync(join(cwd, '.dsh/memory/facts/broken.md'), '没有 frontmatter', 'utf8')
    const { memories, warnings } = store.list(cwd)
    expect(memories.length).toBe(1)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('broken.md')
  })

  it('search ranks by keyword relevance', () => {
    store.add({ content: '构建命令是 pnpm build', type: 'procedure', scope: 'project', source: 'user', tags: ['build'] }, cwd)
    store.add({ content: '完全无关的笔记', type: 'fact', scope: 'project', source: 'user' }, cwd)
    const results = store.search('pnpm 构建', cwd)
    expect(results.length).toBe(1)
    expect(results[0]?.memory.body).toContain('pnpm build')
  })

  it('rebuild rewrites indexes for both scopes', () => {
    store.add({ content: 'x', type: 'fact', scope: 'project', source: 'user' }, cwd)
    store.add({ content: 'y', type: 'fact', scope: 'global', source: 'user' }, cwd)
    const { indexes, warnings } = store.rebuild(cwd)
    expect(indexes.length).toBe(2)
    expect(warnings).toEqual([])
  })

  it('toggles fall back to defaults without a domain', async () => {
    expect(await store.toggles()).toEqual({ recallEnabled: true, captureEnabled: true })
    expect(await store.setToggles({ recallEnabled: false })).toBe(false)
  })
})
