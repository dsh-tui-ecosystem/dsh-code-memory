import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/store/store.js'
import { buildCompactReport } from '../src/store/compact.js'
import { RecallTracker } from '../src/recall/tracker.js'
import { resolveConfig } from '../src/config.js'
import type { Session } from '@deepseek-ai/dsh-session'

let root: string
let cwd: string
let store: MemoryStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mem-compact-'))
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

/** Rewrite a memory file's lastConfirmed to simulate age. */
function ageMemory(dir: string, file: string, isoDate: string): void {
  const abs = join(dir, file)
  writeFileSync(abs, readFileSync(abs, 'utf8').replace(/lastConfirmed: .*/u, `lastConfirmed: ${isoDate}`))
}

describe('buildCompactReport', () => {
  it('reports near-duplicate pairs sharing tags and topic', () => {
    store.add({ content: '构建命令是 pnpm build', type: 'procedure', scope: 'project', source: 'user', tags: ['build'] }, cwd)
    store.add({ content: '构建命令是 pnpm build（不要加多余参数）', type: 'procedure', scope: 'project', source: 'user', tags: ['build'] }, cwd)
    store.add({ content: '完全无关的部署笔记', type: 'fact', scope: 'project', source: 'user' }, cwd)
    const report = buildCompactReport(store, cwd)
    expect(report.nearDupPairs.length).toBe(1)
    expect(report.ancient.length).toBe(0)
  })

  it('catches exact duplicates with no tags at all', () => {
    store.add({ content: '部署前先跑 pnpm build', type: 'procedure', scope: 'project', source: 'user' }, cwd)
    store.add({ content: '部署前先跑 pnpm build', type: 'procedure', scope: 'project', source: 'agent-inferred' }, cwd)
    const report = buildCompactReport(store, cwd)
    expect(report.nearDupPairs.length).toBe(1)
    expect(report.nearDupPairs[0]?.similarity).toBe(1)
  })

  it('reports memories whose anchored paths all vanished', () => {
    store.add({ content: '注册红线', type: 'fact', scope: 'project', source: 'user', paths: ['src/gone.ts'] }, cwd)
    const report = buildCompactReport(store, cwd)
    expect(report.stale.length).toBe(1)
  })

  it('reports ancient low-importance memories only', () => {
    const old = store.add({ content: '陈年旧事', type: 'fact', scope: 'project', source: 'user', importance: 2 }, cwd)
    const oldImportant = store.add({ content: '陈旧但关键', type: 'fact', scope: 'project', source: 'user', importance: 5 }, cwd)
    for (const memory of [old.memory, oldImportant.memory]) {
      ageMemory(join(cwd, '.dsh/memory'), memory.file, '2026-01-01T00:00:00.000Z')
    }
    const report = buildCompactReport(store, cwd)
    expect(report.ancient.map((memory) => memory.id)).toEqual([old.memory.id])
  })
})

describe('RecallTracker', () => {
  const session = { header: { cwd: '/x' } } as unknown as Session

  it('attributes a follow-up to the recall channel within the TTL', () => {
    const tracker = new RecallTracker()
    tracker.record(session, ['mem_a'], 'pre-step', 1000)
    expect(tracker.lookup(session, 'mem_a', 1000 + 60_000)).toBe('pre-step')
  })

  it('expires entries past the TTL and never invents hits', () => {
    const tracker = new RecallTracker()
    tracker.record(session, ['mem_a'], 'on-error', 1000)
    expect(tracker.lookup(session, 'mem_a', 1000 + 31 * 60 * 1000)).toBeUndefined()
    expect(tracker.lookup(session, 'mem_never', 1000)).toBeUndefined()
    expect(tracker.lookup(undefined, 'mem_a', 1000)).toBeUndefined()
  })

  it('tracks sessions independently', () => {
    const tracker = new RecallTracker()
    const other = { header: { cwd: '/y' } } as unknown as Session
    tracker.record(session, ['mem_a'], 'session-start')
    expect(tracker.lookup(other, 'mem_a')).toBeUndefined()
  })
})
