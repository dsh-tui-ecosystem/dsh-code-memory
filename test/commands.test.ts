import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/store.js'
import { resolveConfig } from '../src/config.js'
import {
  memoryAdd,
  memoryCompact,
  memoryList,
  memoryOverview,
  memoryRebuild,
  memoryRm,
  memorySearch,
  memoryShow,
  memoryStats,
  memoryToggle,
} from '../src/commands.js'

let root: string
let cwd: string
let store: MemoryStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mem-cmd-'))
  cwd = join(root, 'repo')
  mkdirSync(cwd, { recursive: true })
  // Pin the project root: without a .git here, findProjectRoot walks up and
  // escapes the tmp sandbox whenever an ancestor (e.g. /tmp/.git) is a repo.
  mkdirSync(join(cwd, '.git'), { recursive: true })
  process.env.DSH_HOME = join(root, 'dsh-home')
  store = new MemoryStore(resolveConfig({}))
  store.detachDomain()
})

afterEach(() => {
  delete process.env.DSH_HOME
  rmSync(root, { recursive: true, force: true })
})

describe('/memory command handlers', () => {
  it('add then list shows the memory', () => {
    const addOut = memoryAdd(store, cwd, ['构建命令是', 'pnpm', 'build', '--tags', 'build', '--type', 'procedure'])
    expect(addOut).toContain('已写入 mem_')
    const listOut = memoryList(store, cwd, [])
    expect(listOut).toContain('构建命令是 pnpm build')
    expect(listOut).toContain('[project/procedure]')
  })

  it('add without content prints usage', () => {
    expect(memoryAdd(store, cwd, [])).toContain('缺少记忆内容')
  })

  it('add reports conflicts', () => {
    memoryAdd(store, cwd, ['测试命令是', 'pnpm', 'vitest', '--tags', 'test'])
    const out = memoryAdd(store, cwd, ['测试命令是', 'pnpm', 'test', '--tags', 'test'])
    expect(out).toContain('可能冲突')
  })

  it('show/rm by id', () => {
    memoryAdd(store, cwd, ['目标记忆'])
    const id = /mem_[0-9A-Z]+/u.exec(memoryList(store, cwd, []))?.[0]
    expect(id).toBeDefined()
    const shown = memoryShow(store, cwd, id)
    expect(shown.kind).toBe('success')
    if (shown.kind === 'success') expect(shown.text).toContain('目标记忆')
    expect(memoryRm(store, cwd, id).kind).toBe('success')
    expect(memoryShow(store, cwd, id).kind).toBe('error')
  })

  it('search finds by keyword', () => {
    memoryAdd(store, cwd, ['部署用', 'docker', 'compose'])
    const out = memorySearch(store, cwd, ['docker'])
    expect(out).toContain('docker compose')
    expect(out).toContain('score=')
  })

  it('overview counts scopes', async () => {
    memoryAdd(store, cwd, ['项目记忆'])
    memoryAdd(store, cwd, ['全局记忆', '--scope', 'global'])
    const out = await memoryOverview(store, cwd)
    expect(out).toContain('global 1 条')
    expect(out).toContain('project 1 条')
  })

  it('toggle without domain reports non-persistent', async () => {
    const result = await memoryToggle(store, false)
    expect(result.kind).toBe('error')
  })

  it('rebuild reports rewritten indexes', () => {
    memoryAdd(store, cwd, ['x'])
    expect(memoryRebuild(store, cwd)).toContain('MEMORY.md')
  })

  it('stats reports counts and freshness buckets', () => {
    memoryAdd(store, cwd, ['项目条', '--type', 'procedure'])
    memoryAdd(store, cwd, ['全局条', '--scope', 'global'])
    const out = memoryStats(store, cwd)
    expect(out).toContain('active 2 条')
    expect(out).toContain('procedure=1')
    expect(out).toContain('<7d=2')
  })

  it('compact reports near-duplicates and stays quiet on a healthy library', () => {
    expect(memoryCompact(store, cwd)).toContain('记忆库健康')
    memoryAdd(store, cwd, ['构建命令是', 'pnpm', 'build', '--tags', 'build'])
    memoryAdd(store, cwd, ['构建命令是', 'pnpm', 'build', '工具', '--tags', 'build'])
    const out = memoryCompact(store, cwd)
    expect(out).toContain('近重复对')
  })

  it('list --all includes everything, filters by scope keyword', () => {
    memoryAdd(store, cwd, ['项目条'])
    memoryAdd(store, cwd, ['全局条', '--scope', 'global'])
    expect(memoryList(store, cwd, ['global'])).toContain('全局条')
    expect(memoryList(store, cwd, ['global'])).not.toContain('项目条')
  })
})
