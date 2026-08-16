import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/store.js'
import { resolveConfig } from '../src/config.js'
import { createMemoryTools } from '../src/tools.js'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

let root: string
let cwd: string
let store: MemoryStore
let tools: ReturnType<typeof createMemoryTools>

/** Minimal ToolRunContext stand-in; the tools only read agent via resolveCwd. */
const fakeExec = {} as ToolRunContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mem-tools-'))
  cwd = join(root, 'repo')
  mkdirSync(cwd, { recursive: true })
  process.env.DSH_HOME = join(root, 'dsh-home')
  store = new MemoryStore(resolveConfig({}))
  store.detachDomain()
  tools = createMemoryTools(store, resolveConfig({}), () => cwd)
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(root, { recursive: true, force: true })
})

const [memoryWrite, memorySearch, memoryGet] = [
  () => tools[0].execute.bind(tools[0]),
  () => tools[1].execute.bind(tools[1]),
  () => tools[2].execute.bind(tools[2]),
]

describe('memory tools', () => {
  it('memory_write persists and returns written status', async () => {
    const write = memoryWrite()
    const result = await write(
      { content: '构建命令是 pnpm build', type: 'procedure', scope: 'project', tags: ['build'] },
      fakeExec,
    ) as { status: string; id: string }
    expect(result.status).toBe('written')
    expect(result.id).toMatch(/^mem_/)
    expect(store.get(result.id, cwd)?.body).toBe('构建命令是 pnpm build')
  })

  it('memory_write reports conflicts, then supersedes on confirmation', async () => {
    const write = memoryWrite()
    const first = await write(
      { content: '测试命令是 pnpm test', type: 'procedure', scope: 'project', tags: ['test'] },
      fakeExec,
    ) as { status: string; id: string }
    const conflicting = await write(
      { content: '测试命令已迁移到 pnpm vitest', type: 'procedure', scope: 'project', tags: ['test'] },
      fakeExec,
    ) as { status: string; id: string; conflicts: string[] }
    expect(conflicting.status).toBe('conflict')
    expect(conflicting.conflicts[0]).toContain(first.id)

    const resolved = await write(
      { content: '测试命令已迁移到 pnpm vitest run', type: 'procedure', scope: 'project', tags: ['test'], supersede: first.id },
      fakeExec,
    ) as { status: string; id: string; superseded?: string }
    expect(resolved.status).toBe('written')
    expect(resolved.superseded).toBe(first.id)

    const old = store.get(first.id, cwd)
    expect(old?.status).toBe('superseded')
    expect(old?.supersededBy).toBe(resolved.id)
    // 索引只保留 active 条目
    const { memories } = store.list(cwd)
    expect(memories.every((memory) => memory.status === 'active')).toBe(true)
  })

  it('memory_write rejects supersede of a missing id', async () => {
    const write = memoryWrite()
    const result = await write(
      { content: 'x', type: 'fact', scope: 'project', supersede: 'mem_01JZKAAAAAAAAAAAAAAAAAAAAA' },
      fakeExec,
    ) as { status: string; conflicts: string[] }
    expect(result.status).toBe('conflict')
    expect(result.conflicts[0]).toContain('不存在')
  })

  it('memory_search and memory_get round-trip', async () => {
    const write = memoryWrite()
    const written = await write(
      { content: '部署用 docker compose up', type: 'procedure', scope: 'project', tags: ['deploy'] },
      fakeExec,
    ) as { id: string }
    const search = memorySearch()
    const found = await search({ query: 'docker' }, fakeExec) as { count: number; results: string[] }
    expect(found.count).toBe(1)
    expect(found.results[0]).toContain(written.id)

    const get = memoryGet()
    const got = await get({ id: written.id }, fakeExec) as { found: boolean; content: string }
    expect(got.found).toBe(true)
    expect(got.content).toBe('部署用 docker compose up')
    const missing = await get({ id: 'mem_01JZKAAAAAAAAAAAAAAAAAAAAA' }, fakeExec) as { found: boolean }
    expect(missing.found).toBe(false)
  })
})
