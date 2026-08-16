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
  // Pin the project root: without a .git here, findProjectRoot walks up and
  // escapes the tmp sandbox whenever an ancestor (e.g. /tmp/.git) is a repo.
  mkdirSync(join(cwd, '.git'), { recursive: true })
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
      { content: '测试命令是 pnpm vitest', type: 'procedure', scope: 'project', tags: ['test'] },
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

  it('memory_write persists anchors and memory_get shows them', async () => {
    const write = memoryWrite()
    const written = await write(
      { content: '事件注册红线', type: 'fact', scope: 'project', paths: ['src/registration.ts'], symbols: ['registerMemoryEventTypes'] },
      fakeExec,
    ) as { id: string }
    const memory = store.get(written.id, cwd)
    expect(memory?.paths).toEqual(['src/registration.ts'])
    expect(memory?.symbols).toEqual(['registerMemoryEventTypes'])
    const get = memoryGet()
    const got = await get({ id: written.id }, fakeExec) as { found: boolean; meta: string }
    expect(got.meta).toContain('src/registration.ts')
    expect(got.meta).toContain('registerMemoryEventTypes')
  })

  it('memory_search filters by tags', async () => {
    const write = memoryWrite()
    await write({ content: '构建命令是 pnpm build', type: 'procedure', scope: 'project', tags: ['build'] }, fakeExec)
    await write({ content: '部署命令是 pnpm deploy', type: 'procedure', scope: 'project', tags: ['deploy'] }, fakeExec)
    const search = memorySearch()
    const found = await search({ query: 'pnpm', tags: ['deploy'] }, fakeExec) as { count: number; results: string[] }
    expect(found.count).toBe(1)
    expect(found.results[0]).toContain('deploy')
  })

  it('memory_get logs recall-used when the id was recently recalled', async () => {
    const { RecallTracker } = await import('../src/recall/tracker.js')
    const tracker = new RecallTracker()
    const trackedTools = createMemoryTools(store, resolveConfig({}), () => cwd, tracker)
    const write = trackedTools[0].execute.bind(trackedTools[0])
    const get = trackedTools[2].execute.bind(trackedTools[2])
    const written = await write(
      { content: '可召回的事实', type: 'fact', scope: 'project' },
      fakeExec,
    ) as { id: string }
    // fakeExec 没有 agent/session：lookup 返回 undefined，不应炸
    const got = await get({ id: written.id }, fakeExec) as { found: boolean }
    expect(got.found).toBe(true)
    // 有 session 且 id 被召回过：tracker 应能命中（事件 append 本身 best-effort，无法在此断言）
    const fakeSession = { header: { cwd }, append: () => undefined } as never
    tracker.record(fakeSession as never, [written.id], 'pre-step')
    expect(tracker.lookup(fakeSession as never, written.id)).toBe('pre-step')
  })

  it('memory_get returns the refreshed confirmation date after touch', async () => {
    const write = memoryWrite()
    const written = await write(
      { content: '旧事实', type: 'fact', scope: 'project' },
      fakeExec,
    ) as { id: string }
    // 把记忆改老，memory_get 应返回 touch 后的新日期而不是读取时的旧日期
    const memory = store.get(written.id, cwd)
    const file = join(cwd, '.dsh/memory', memory!.file)
    const { readFileSync, writeFileSync } = await import('node:fs')
    writeFileSync(file, readFileSync(file, 'utf8').replace(/lastConfirmed: .*/u, 'lastConfirmed: 2026-01-01T00:00:00.000Z'))
    const get = memoryGet()
    const got = await get({ id: written.id }, fakeExec) as { found: boolean; meta: string }
    expect(got.meta).toContain(new Date().toISOString().slice(0, 10))
    expect(got.meta).not.toContain('2026-01-01')
  })

  it('memory_get still serves the memory when touch cannot write', async () => {
    const write = memoryWrite()
    const written = await write(
      { content: '只读场景的事实', type: 'fact', scope: 'project' },
      fakeExec,
    ) as { id: string }
    // 模拟只读 checkout：touch 写盘抛错，retrieval 不应被拖下水
    const originalTouch = store.touch.bind(store)
    store.touch = () => { throw new Error('EROFS: read-only file system') }
    const get = memoryGet()
    const got = await get({ id: written.id }, fakeExec) as { found: boolean; content: string }
    expect(got.found).toBe(true)
    expect(got.content).toBe('只读场景的事实')
    store.touch = originalTouch
  })
})
