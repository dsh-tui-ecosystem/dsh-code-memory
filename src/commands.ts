/**
 * `/memory` command family + optional TUI completion tree. All output goes
 * through CommandResult.text, which the dispatching UI renders directly —
 * no custom surfaces, so every frontend (TUI included) gets the same views.
 * @module dsh-code-memory/commands
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.commands.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { MEMORY_SCOPES, MEMORY_TYPES } from './types.js'
import type { Memory, MemoryScope, MemoryType } from './types.js'
import type { MemoryStore } from './store/store.js'
import { summarize } from './store/index-file.js'

/** Structural view of the TUI command-tree service; the real type lives in dsh-TUI. */
interface TuiCommandTreesLike {
  register(provider: {
    root: string
    descriptions?: Readonly<Partial<Record<'zh' | 'en', string>>>
    children(canonicalPath: readonly string[]): readonly {
      name: string
      description: string
      descriptions?: Readonly<Partial<Record<'zh' | 'en', string>>>
    }[]
  }): () => void
}

const SUBCOMMANDS = [
  { name: 'list', description: '列出记忆（[global|project] [fact|episode|procedure] [--all]）' },
  { name: 'add', description: '显式写入一条记忆（--scope --type --tags --importance）' },
  { name: 'show', description: '查看一条记忆全文（<id>）' },
  { name: 'rm', description: '删除一条记忆（<id>）' },
  { name: 'search', description: '关键词检索（<query>）' },
  { name: 'on', description: '开启自动召回与捕获' },
  { name: 'off', description: '关闭自动召回与捕获' },
  { name: 'rebuild', description: '从文件重建 MEMORY.md 索引与镜像' },
] as const

function parseFlags(args: string[]): { flags: Record<string, string>; rest: string[] } {
  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg !== undefined && arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('--')) {
        flags[key] = value
        i += 1
      } else {
        flags[key] = 'true'
      }
    } else if (arg !== undefined) {
      rest.push(arg)
    }
  }
  return { flags, rest }
}

function asScope(value: string | undefined): MemoryScope | undefined {
  return MEMORY_SCOPES.find((scope) => scope === value)
}

function asType(value: string | undefined): MemoryType | undefined {
  return MEMORY_TYPES.find((type) => type === value)
}

function formatLine(memory: Memory): string {
  const date = memory.lastConfirmed.slice(0, 10)
  const stale = memory.status === 'superseded' ? ' ⧗superseded' : ''
  return `${memory.id}  [${memory.scope}/${memory.type}]${stale}  ${date}  ${summarize(memory, 60)}`
}

const USAGE = `用法：
  /memory                      概览
  /memory list [scope] [type] [--all]
  /memory add <内容> [--scope project|global] [--type fact|episode|procedure] [--tags a,b] [--importance 1-5]
  /memory show <id>
  /memory rm <id>
  /memory search <关键词>
  /memory on | off             开关自动召回与捕获
  /memory rebuild              重建索引与镜像`

/** Register the /memory command and (when the TUI is composed) its completion tree. */
export function registerMemoryCommands(ctx: Context, store: MemoryStore): void {
  ctx.commands.register({
    name: 'memory',
    description: '跨会话记忆：浏览、写入、检索、开关',
    input: { hint: '[list|add|show|rm|search|on|off|rebuild] …' },
    handler: async ({ agent, rawInput }): Promise<CommandResult> => {
      const cwd = agent.session.header.cwd ?? process.cwd()
      const [sub = '', ...rest] = rawInput.trim().split(/\s+/u).filter((part) => part.length > 0)
      try {
        switch (sub) {
          case '':
            return { kind: 'success', text: await memoryOverview(store, cwd) }
          case 'list':
            return { kind: 'success', text: memoryList(store, cwd, rest) }
          case 'add':
            return { kind: 'success', text: memoryAdd(store, cwd, rest) }
          case 'show':
            return memoryShow(store, cwd, rest[0])
          case 'rm':
            return memoryRm(store, cwd, rest[0])
          case 'search':
            return { kind: 'success', text: memorySearch(store, cwd, rest.join(' ')) }
          case 'on':
            return memoryToggle(store, true)
          case 'off':
            return memoryToggle(store, false)
          case 'rebuild':
            return { kind: 'success', text: memoryRebuild(store, cwd) }
          default:
            return { kind: 'error', text: `未知子命令 "${sub}"。\n${USAGE}` }
        }
      } catch (error) {
        return { kind: 'error', text: `memory 命令失败：${String(error)}` }
      }
    },
  })

  const trees = ctx.get('tuiCommandTrees', false) as TuiCommandTreesLike | undefined
  trees?.register({
    root: 'memory',
    descriptions: { zh: '跨会话记忆', en: 'Cross-session memory' },
    children: (path) => (path.length === 1 ? SUBCOMMANDS : []),
  })
}

export async function memoryOverview(store: MemoryStore, cwd: string): Promise<string> {
  const { memories, warnings } = store.list(cwd, { all: true })
  const toggles = await store.toggles()
  const byScope = { global: 0, project: 0 }
  let superseded = 0
  for (const memory of memories) {
    if (memory.status === 'superseded') superseded += 1
    else byScope[memory.scope] += 1
  }
  const lines = [
    `记忆库：global ${byScope.global} 条，project ${byScope.project} 条（另 ${superseded} 条已失效）`,
    `自动召回 ${toggles.recallEnabled ? '开' : '关'} · 自动捕获 ${toggles.captureEnabled ? '开' : '关'}`,
  ]
  if (warnings.length > 0) lines.push(`⚠ ${warnings.length} 个文件解析失败：`, ...warnings.map((w) => `  - ${w}`))
  const recent = memories.filter((m) => m.status === 'active').slice(0, 5)
  if (recent.length > 0) lines.push('最近写入：', ...recent.map(formatLine))
  return lines.join('\n')
}

export function memoryList(store: MemoryStore, cwd: string, args: string[]): string {
  const { flags, rest } = parseFlags(args)
  let scope: MemoryScope | undefined
  let type: MemoryType | undefined
  for (const word of rest) {
    scope ??= asScope(word)
    type ??= asType(word)
  }
  const { memories, warnings } = store.list(cwd, {
    ...(scope !== undefined ? { scope } : {}),
    ...(type !== undefined ? { type } : {}),
    all: flags['all'] === 'true',
  })
  if (memories.length === 0) return '（没有匹配的记忆）'
  const lines = memories.map(formatLine)
  if (warnings.length > 0) lines.push('', ...warnings.map((w) => `⚠ ${w}`))
  return lines.join('\n')
}

export function memoryAdd(store: MemoryStore, cwd: string, args: string[]): string {
  const { flags, rest } = parseFlags(args)
  const content = rest.join(' ').trim()
  if (content.length === 0) return `缺少记忆内容。\n${USAGE}`
  const result = store.add({
    content,
    type: asType(flags['type']) ?? 'fact',
    scope: asScope(flags['scope']) ?? 'project',
    source: 'user',
    tags: flags['tags']?.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0),
    ...(flags['importance'] !== undefined ? { importance: Number(flags['importance']) } : {}),
  }, cwd)
  const lines = [`已写入 ${result.memory.id} → ${result.memory.scope}:${result.memory.file}`]
  if (result.truncated) lines.push('⚠ 内容超长，已截断到 2000 字符')
  if (result.conflicts.length > 0) {
    lines.push(`⚠ 发现 ${result.conflicts.length} 条可能冲突的既有记忆：`)
    for (const conflict of result.conflicts) lines.push(`  ${formatLine(conflict)}`)
  }
  return lines.join('\n')
}

export function memoryShow(store: MemoryStore, cwd: string, id: string | undefined): CommandResult {
  if (id === undefined) return { kind: 'error', text: `缺少 id。\n${USAGE}` }
  const memory = store.get(id, cwd)
  if (memory === undefined) return { kind: 'error', text: `找不到 ${id}` }
  const tags = memory.tags.length > 0 ? memory.tags.join(', ') : '（无）'
  const superseded = memory.status === 'superseded'
    ? `\n状态：superseded${memory.supersededBy !== undefined ? `（被 ${memory.supersededBy} 取代）` : ''}`
    : ''
  return {
    kind: 'success',
    text: [
      `${memory.id}  [${memory.scope}/${memory.type}]  source=${memory.source}  importance=${memory.importance}`,
      `tags: ${tags}  created: ${memory.created.slice(0, 10)}  last_confirmed: ${memory.lastConfirmed.slice(0, 10)}${superseded}`,
      '',
      memory.body,
    ].join('\n'),
  }
}

export function memoryRm(store: MemoryStore, cwd: string, id: string | undefined): CommandResult {
  if (id === undefined) return { kind: 'error', text: `缺少 id。\n${USAGE}` }
  const removed = store.remove(id, cwd)
  if (removed === undefined) return { kind: 'error', text: `找不到 ${id}` }
  return { kind: 'success', text: `已删除 ${id}（${removed.scope}:${removed.file}）` }
}

export function memorySearch(store: MemoryStore, cwd: string, query: string): string {
  if (query.trim().length === 0) return `缺少关键词。\n${USAGE}`
  const results = store.search(query, cwd).slice(0, 10)
  if (results.length === 0) return '（没有匹配的记忆）'
  return results.map((scored) =>
    `${formatLine(scored.memory)}\n    score=${scored.score.toFixed(3)} (rel=${scored.relevance.toFixed(2)} rec=${scored.recency.toFixed(2)} imp=${scored.importance.toFixed(2)})`,
  ).join('\n')
}

export async function memoryToggle(store: MemoryStore, enabled: boolean): Promise<CommandResult> {
  const ok = await store.setToggles({ recallEnabled: enabled, captureEnabled: enabled })
  if (!ok) return { kind: 'error', text: '存储域不可用，开关未持久化（重启后恢复默认开启）' }
  return { kind: 'success', text: `自动召回与捕获已${enabled ? '开启' : '关闭'}` }
}

export function memoryRebuild(store: MemoryStore, cwd: string): string {
  const { indexes, warnings } = store.rebuild(cwd)
  const lines = indexes.map((dir) => `已重建索引：${dir}/MEMORY.md`)
  if (warnings.length > 0) lines.push(...warnings.map((w) => `⚠ ${w}`))
  return lines.join('\n')
}
