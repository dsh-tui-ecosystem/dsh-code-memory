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
import { buildCompactReport } from './store/compact.js'
import { pathsStale } from './recall/staleness.js'

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
  { name: 'list', description: '列出记忆（[global|project] [fact|episode|procedure] [--all] [--tags a,b]）' },
  { name: 'add', description: '显式写入一条记忆（--scope --type --tags --paths --symbols --importance）' },
  { name: 'show', description: '查看一条记忆全文（<id>）' },
  { name: 'rm', description: '删除一条记忆（<id>）' },
  { name: 'search', description: '关键词检索（<query> [--tags a,b]）' },
  { name: 'stats', description: '记忆库健康统计（数量/来源/陈旧度/失效锚点）' },
  { name: 'compact', description: '巩固报告：近重复对、失效锚点、长期未确认记忆' },
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

function formatLine(memory: Memory, cwd?: string): string {
  const date = memory.lastConfirmed.slice(0, 10)
  const superseded = memory.status === 'superseded' ? ' ⧗superseded' : ''
  const stale = cwd !== undefined && memory.status === 'active' && pathsStale(memory, cwd) ? ' ⚠stale' : ''
  return `${memory.id}  [${memory.scope}/${memory.type}]${superseded}${stale}  ${date}  ${summarize(memory, 60)}`
}

function parseList(value: string | undefined): string[] | undefined {
  return value?.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
}

const USAGE = `用法：
  /memory                      概览
  /memory list [scope] [type] [--all] [--tags a,b]
  /memory add <内容> [--scope project|global] [--type fact|episode|procedure] [--tags a,b] [--paths x/y.ts,...] [--symbols foo,...] [--importance 1-5]
  /memory show <id>
  /memory rm <id>
  /memory search <关键词> [--tags a,b]
  /memory stats                记忆库健康统计
  /memory compact              巩固报告（近重复/失效锚点/长期未确认）
  /memory on | off             开关自动召回与捕获
  /memory rebuild              重建索引与镜像`

/** Register the /memory command and (when the TUI is composed) its completion tree. */
export function registerMemoryCommands(ctx: Context, store: MemoryStore): void {
  ctx.commands.register({
    name: 'memory',
    description: '跨会话记忆：浏览、写入、检索、巩固、开关',
    input: { hint: '[list|add|show|rm|search|stats|compact|on|off|rebuild] …' },
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
            return { kind: 'success', text: memorySearch(store, cwd, rest) }
          case 'stats':
            return { kind: 'success', text: memoryStats(store, cwd) }
          case 'compact':
            return { kind: 'success', text: memoryCompact(store, cwd) }
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
  if (recent.length > 0) lines.push('最近写入：', ...recent.map((m) => formatLine(m, cwd)))
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
  const tags = parseList(flags['tags'])
  const { memories, warnings } = store.list(cwd, {
    ...(scope !== undefined ? { scope } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(tags !== undefined ? { tags } : {}),
    all: flags['all'] === 'true',
  })
  if (memories.length === 0) return '（没有匹配的记忆）'
  const lines = memories.map((m) => formatLine(m, cwd))
  if (warnings.length > 0) lines.push('', ...warnings.map((w) => `⚠ ${w}`))
  return lines.join('\n')
}

export function memoryAdd(store: MemoryStore, cwd: string, args: string[]): string {
  const { flags, rest } = parseFlags(args)
  const content = rest.join(' ').trim()
  if (content.length === 0) return `缺少记忆内容。\n${USAGE}`
  const paths = parseList(flags['paths'])
  const symbols = parseList(flags['symbols'])
  const result = store.add({
    content,
    type: asType(flags['type']) ?? 'fact',
    scope: asScope(flags['scope']) ?? 'project',
    source: 'user',
    tags: parseList(flags['tags']),
    ...(paths !== undefined ? { paths } : {}),
    ...(symbols !== undefined ? { symbols } : {}),
    ...(flags['importance'] !== undefined ? { importance: Number(flags['importance']) } : {}),
  }, cwd)
  const lines = [`已写入 ${result.memory.id} → ${result.memory.scope}:${result.memory.file}`]
  if (result.memory.paths.length > 0) lines.push(`锚点路径：${result.memory.paths.join(', ')}`)
  if (result.truncated) lines.push('⚠ 内容超长，已截断到 2000 字符')
  if (result.conflicts.length > 0) {
    lines.push(`⚠ 发现 ${result.conflicts.length} 条可能冲突的既有记忆：`)
    for (const conflict of result.conflicts) lines.push(`  ${formatLine(conflict, cwd)}`)
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
  const anchors = [
    ...(memory.paths.length > 0 ? [`paths: ${memory.paths.join(', ')}${pathsStale(memory, cwd) ? '（⚠ 全部已不存在于磁盘）' : ''}`] : []),
    ...(memory.symbols.length > 0 ? [`symbols: ${memory.symbols.join(', ')}`] : []),
  ]
  return {
    kind: 'success',
    text: [
      `${memory.id}  [${memory.scope}/${memory.type}]  source=${memory.source}  importance=${memory.importance}`,
      `tags: ${tags}  created: ${memory.created.slice(0, 10)}  last_confirmed: ${memory.lastConfirmed.slice(0, 10)}${superseded}`,
      ...anchors,
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

export function memorySearch(store: MemoryStore, cwd: string, args: string[]): string {
  const { flags, rest } = parseFlags(args)
  const query = rest.join(' ')
  if (query.trim().length === 0) return `缺少关键词。\n${USAGE}`
  const tags = parseList(flags['tags'])
  const results = store.search(query, cwd, {
    ...(tags !== undefined ? { tags } : {}),
  }).slice(0, 10)
  if (results.length === 0) return '（没有匹配的记忆）'
  return results.map((scored) =>
    `${formatLine(scored.memory, cwd)}\n    score=${scored.score.toFixed(3)} (rel=${scored.relevance.toFixed(2)} rec=${scored.recency.toFixed(2)} imp=${scored.importance.toFixed(2)})`,
  ).join('\n')
}

export function memoryStats(store: MemoryStore, cwd: string): string {
  const { memories, warnings } = store.list(cwd, { all: true })
  const active = memories.filter((memory) => memory.status === 'active')
  const byType: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  let stale = 0
  const ageBuckets = { '<7d': 0, '7-30d': 0, '30-90d': 0, '>90d': 0 }
  const nowMs = Date.now()
  for (const memory of active) {
    byType[memory.type] = (byType[memory.type] ?? 0) + 1
    bySource[memory.source] = (bySource[memory.source] ?? 0) + 1
    if (pathsStale(memory, cwd)) stale += 1
    const confirmedMs = Date.parse(memory.lastConfirmed)
    const ageDays = Number.isFinite(confirmedMs) ? (nowMs - confirmedMs) / 86_400_000 : 365
    if (ageDays < 7) ageBuckets['<7d'] += 1
    else if (ageDays < 30) ageBuckets['7-30d'] += 1
    else if (ageDays < 90) ageBuckets['30-90d'] += 1
    else ageBuckets['>90d'] += 1
  }
  const lines = [
    `active ${active.length} 条 · superseded ${memories.length - active.length} 条`,
    `类型：${Object.entries(byType).map(([key, count]) => `${key}=${count}`).join(' ') || '（空）'}`,
    `来源：${Object.entries(bySource).map(([key, count]) => `${key}=${count}`).join(' ') || '（空）'}`,
    `未确认时长：<7d=${ageBuckets['<7d']} 7-30d=${ageBuckets['7-30d']} 30-90d=${ageBuckets['30-90d']} >90d=${ageBuckets['>90d']}`,
    `锚点失效（引用路径全部不存在）：${stale} 条`,
  ]
  if (warnings.length > 0) lines.push(`⚠ ${warnings.length} 个文件解析失败`)
  return lines.join('\n')
}

export function memoryCompact(store: MemoryStore, cwd: string): string {
  const report = buildCompactReport(store, cwd)
  const lines: string[] = []
  if (report.nearDupPairs.length > 0) {
    lines.push(`近重复对（${report.nearDupPairs.length} 对，建议保留较新/较准的一条，用 memory_write + supersede 合并）：`)
    for (const pair of report.nearDupPairs) {
      lines.push(`  similarity=${pair.similarity.toFixed(2)}`)
      lines.push(`    ${formatLine(pair.a, cwd)}`)
      lines.push(`    ${formatLine(pair.b, cwd)}`)
    }
  }
  if (report.stale.length > 0) {
    lines.push(`锚点失效（${report.stale.length} 条，引用路径已全部不存在，核实后 supersede 或 rm）：`)
    for (const memory of report.stale) lines.push(`  ${formatLine(memory, cwd)}  原锚点: ${memory.paths.join(', ')}`)
  }
  if (report.ancient.length > 0) {
    lines.push(`长期未确认（${report.ancient.length} 条 >90 天且 importance≤2，建议复审）：`)
    for (const memory of report.ancient) lines.push(`  ${formatLine(memory, cwd)}`)
  }
  if (lines.length === 0) return '记忆库健康：无近重复、无失效锚点、无长期未确认条目。'
  return lines.join('\n')
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
