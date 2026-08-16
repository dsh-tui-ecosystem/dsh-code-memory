/**
 * Agent-facing memory tools, registered on ctx.tools via defineTool:
 * memory_write (with conflict/supersede flow), memory_search, memory_get.
 * The model distills everything it writes — tool output never enters the
 * memory store verbatim, which is the cheapest memory-poisoning defense.
 * @module dsh-code-memory/tools
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.tools.
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.js'
import type { MemoryStore } from './store/store.js'
import { summarize } from './store/index-file.js'
import { MEMORY_SOURCES, MEMORY_TYPES } from './types.js'
import type { MemoryCapturedEvent, MemorySupersededEvent } from './events.js'

/** Resolve the session cwd for a tool execution (tests inject their own). */
export type CwdResolver = (exec: ToolRunContext) => string

const defaultCwd: CwdResolver = (exec) => exec.agent?.session.header.cwd ?? process.cwd()

/** Append a log-only memory event; best-effort, never throws. */
function emit(session: Session | undefined, event: MemoryCapturedEvent | MemorySupersededEvent): void {
  if (session === undefined) return
  queueMicrotask(() => {
    try {
      if ('file' in event) session.append('memory/captured', event)
      else session.append('memory/superseded', event)
    } catch {
      // Session closed or append guard held: observability is best-effort.
    }
  })
}

export function createMemoryTools(store: MemoryStore, config: ResolvedConfig, resolveCwd: CwdResolver = defaultCwd) {
  void config
  const memoryWrite = defineTool({
    name: 'memory_write',
    description: '写入一条跨会话持久记忆（构建/测试命令、调试结论、仓库约定、用户偏好）。内容必须是蒸馏后的结论，不要粘贴工具输出原文。发现冲突时返回 conflict，确认后用 supersede 参数取代旧条目。',
    parameters: {
      content: { type: 'string', required: true, description: '记忆内容（一两句结论，≤2000 字符）' },
      type: { type: 'string', enum: MEMORY_TYPES, required: true, description: 'fact=事实, procedure=可复用流程, episode=一次具体经历' },
      scope: { type: 'string', enum: ['project', 'global'], description: 'project=本仓库（默认）, global=跨项目通用' },
      tags: { type: 'array', items: { type: 'string' }, description: '检索标签（短关键词）' },
      importance: { type: 'integer', enum: [1, 2, 3, 4, 5], description: '重要度 1-5（默认 3）' },
      source: { type: 'string', enum: MEMORY_SOURCES, description: '来源：user=用户明说, agent-inferred=你推断的（默认）, tool-output=来自工具输出的蒸馏' },
      supersede: { type: 'string', description: '要被取代的旧记忆 id（conflict 流程）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['written', 'conflict'] },
          id: { type: 'string' },
          file: { type: 'string' },
          truncated: { type: 'boolean' },
          superseded: { type: 'string' },
          conflicts: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        if (value.status === 'conflict') {
          const lines = value.conflicts ?? []
          return [{ type: 'text' as const, text: `发现 ${lines.length} 条可能冲突的既有记忆：\n${lines.join('\n')}\n若新信息更准确，用 supersede=<旧id> 重写；否则放弃。` }]
        }
        const extra = value.superseded !== undefined ? `，已取代 ${value.superseded}` : ''
        return [{ type: 'text' as const, text: `已记住（${value.id ?? ''}${extra}）。` }]
      },
    },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const cwd = resolveCwd(exec)
      if (args.supersede !== undefined && store.get(args.supersede, cwd) === undefined) {
        return { status: 'conflict' as const, conflicts: [`supersede 目标 ${args.supersede} 不存在，请先用 memory_search 确认 id`] }
      }
      const result = store.add({
        content: args.content,
        type: args.type,
        scope: args.scope ?? 'project',
        source: args.source ?? 'agent-inferred',
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.importance !== undefined ? { importance: args.importance } : {}),
      }, cwd)
      // Unresolved conflicts and no explicit supersede → report back and let
      // the model decide (its next write carries supersede=<oldId>).
      if (args.supersede === undefined && result.conflicts.length > 0) {
        return {
          status: 'conflict' as const,
          id: result.memory.id,
          conflicts: result.conflicts.map((memory) => `${memory.id} — ${summarize(memory, 60)}`),
        }
      }
      let superseded: string | undefined
      if (args.supersede !== undefined) {
        const old = store.supersede(args.supersede, result.memory, cwd)
        if (old !== undefined) {
          superseded = old.id
          emit(exec.agent?.session, { oldId: old.id, newId: result.memory.id })
        }
      }
      emit(exec.agent?.session, {
        id: result.memory.id,
        type: result.memory.type,
        scope: result.memory.scope,
        source: result.memory.source,
        file: result.memory.file,
      })
      return {
        status: 'written' as const,
        id: result.memory.id,
        file: `${result.memory.scope}:${result.memory.file}`,
        truncated: result.truncated,
        ...(superseded !== undefined ? { superseded } : {}),
      }
    },
  })

  const memorySearch = defineTool({
    name: 'memory_search',
    description: '按关键词检索持久记忆，返回相关度排序的列表（id、摘要、来源、日期）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词' },
      scope: { type: 'string', enum: ['project', 'global'], description: '限定作用域' },
      type: { type: 'string', enum: MEMORY_TYPES, description: '限定类型' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          results: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        { type: 'text' as const, text: (value.count ?? 0) === 0 ? '没有匹配的记忆。' : (value.results ?? []).join('\n') },
      ],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const cwd = resolveCwd(exec)
      const ranked = store.search(args.query, cwd, {
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.type !== undefined ? { type: args.type } : {}),
      }).slice(0, 10)
      return {
        count: ranked.length,
        results: ranked.map((scored) => {
          const memory = scored.memory
          return `${memory.id} [${memory.scope}/${memory.type} · ${memory.source} · ${memory.lastConfirmed.slice(0, 10)}] ${summarize(memory, 80)}`
        }),
      }
    },
  })

  const memoryGet = defineTool({
    name: 'memory_get',
    description: '按 id 读取一条记忆的完整内容。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆 id（mem_ 开头）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean' },
          id: { type: 'string' },
          meta: { type: 'string' },
          content: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text' as const, text: value.found === true ? `${value.meta ?? ''}\n\n${value.content ?? ''}` : '找不到该记忆。' },
      ],
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const memory = store.get(args.id, resolveCwd(exec))
      if (memory === undefined) return { found: false as const }
      const meta = `${memory.id} [${memory.scope}/${memory.type} · ${memory.source} · importance=${memory.importance} · ${memory.lastConfirmed.slice(0, 10)}]${memory.status === 'superseded' ? '（已失效）' : ''}`
      return { found: true as const, id: memory.id, meta, content: memory.body }
    },
  })

  return [memoryWrite, memorySearch, memoryGet] as const
}

/** Register all memory tools on the tools runtime. */
export function registerMemoryTools(ctx: Context, store: MemoryStore, config: ResolvedConfig): void {
  for (const tool of createMemoryTools(store, config)) {
    ctx.tools.register(tool)
  }
}
