import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'
import { toolErrorQuery, registerCapture } from '../src/hooks/capture.js'
import { MemoryStore } from '../src/store/store.js'
import { resolveConfig } from '../src/config.js'

describe('toolErrorQuery', () => {
  it('builds the query from the model-facing result text, not just the error identity', () => {
    const query = toolErrorQuery({
      message: {
        content: [{
          type: 'tool-result',
          content: [{ type: 'text', text: "TS2307: Cannot find module './store.js'" }],
        }],
      },
      error: { name: 'ToolError', code: 'EXEC_FAILED' },
    })
    expect(query).toContain("TS2307: Cannot find module './store.js'")
    expect(query).toContain('ToolError EXEC_FAILED')
  })

  it('falls back to name/code when the result carries no text', () => {
    const query = toolErrorQuery({
      message: { content: [{ type: 'tool-result', content: [] }] },
      error: { name: 'TimeoutError', code: 'ETIMEDOUT' },
    })
    expect(query).toBe('TimeoutError ETIMEDOUT')
  })

  it('returns empty string when there is nothing searchable', () => {
    expect(toolErrorQuery({ message: { content: [] } })).toBe('')
  })

  it('caps the query length', () => {
    const query = toolErrorQuery({
      message: {
        content: [{
          type: 'tool-result',
          content: [{ type: 'text', text: 'x'.repeat(5000) }],
        }],
      },
    })
    expect(query.length).toBeLessThanOrEqual(500)
  })
})

describe('error-triggered recall rate limiting', () => {
  let root: string
  let cwd: string
  let store: MemoryStore

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-mem-capture-'))
    cwd = join(root, 'repo')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cwd, '.git'), { recursive: true })
    process.env.DSH_HOME = join(root, 'dsh-home')
    store = new MemoryStore(resolveConfig({}))
    store.detachDomain()
  })

  afterEach(() => {
    delete process.env.DSH_HOME
    rmSync(root, { recursive: true, force: true })
  })

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

  function errorEvent(text: string) {
    return {
      type: 'tool/result',
      data: {
        message: { content: [{ type: 'tool-result', content: [{ type: 'text', text }] }] },
        error: { name: 'ToolError', code: 'FAILED' },
      },
    }
  }

  it('releases the reservation when no recall was injected, so a later valid error still recalls', async () => {
    const handlers = new Map<string, (...args: never[]) => void>()
    const ctx = { on: (event: string, cb: (...args: never[]) => void) => handlers.set(event, cb) }
    registerCapture(ctx as never, store, resolveConfig({}))
    const injected: string[] = []
    const session = { header: { cwd }, append: () => undefined }
    const agent = { session, inject: (message: { content: { text: string }[] }) => injected.push(message.content[0].text) }
    handlers.get('agent/created')?.({ agent } as never)
    const onEvent = handlers.get('session/event')!

    store.add({ content: 'Cannot find module 报错的根因是路径别名未配置', type: 'procedure', scope: 'project', source: 'user', tags: ['module', 'cannot', 'find'] }, cwd)

    // 第一个错误：无命中 → 不注入，占位必须释放
    onEvent(session as never, errorEvent('ENOENT permission denied') as never)
    await flush()
    expect(injected.length).toBe(0)

    // 第二个错误紧跟（远小于 5 分钟限流）：有命中 → 必须能注入
    onEvent(session as never, errorEvent('Cannot find module @/store') as never)
    await flush()
    expect(injected.length).toBe(1)
    expect(injected[0]).toContain('路径别名')

    // 第三个错误同样有命中，但在成功注入后的限流窗口内 → 被压住
    onEvent(session as never, errorEvent('Cannot find module @/index') as never)
    await flush()
    expect(injected.length).toBe(1)
  })
})
