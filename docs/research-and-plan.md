# dsh-code-memory 记忆插件：调研与开发计划

> 目标：为 dsh（deepseek-harness）编写一个跨会话记忆插件，兼容 dsh-TUI。
> 调研日期：2026-08-17。本文档分两部分：Part 1 全网调研结论，Part 2 开发计划。

---

# Part 1 · 调研

## 1.1 主流编码 Agent 的记忆实现

### 1.1.1 总览对比

| 工具 | 人工指令层 | 自动记忆层 | 存储 | 注入时机 | 写入方式 | 检索 | 大小预算 |
|---|---|---|---|---|---|---|---|
| **Claude Code** | CLAUDE.md 四级 + `.claude/rules`（glob 条件加载）+ `@`导入 | Auto Memory：`MEMORY.md` 索引 + 主题文件 | `~/.claude/projects/<p>/memory/` | 索引常驻（前 200 行/25KB），详情按需读 | 模型自主记 + `/memory` 管理 | 无 RAG，索引 + 文件工具 | 索引 200 行 / 25KB |
| **Codex CLI** | AGENTS.md（git 根→cwd 逐目录） | Memories：空闲 ~6h 后台双模型整合，30 天未召回自动修剪 | `~/.codex/memories/` | `memory_summary.md` 启动全读 | 全自动后台管线 | 刻意不用向量：全读摘要 + grep | AGENTS.md 合并 32 KiB |
| **Aider** | CONVENTIONS.md 经 `read:` 配置 | 无 | 项目文件 | 每次请求随附 | 纯手工 | Repo Map（tree-sitter + 图排序） | `--map-tokens` 默认 1k |
| **Cursor** | `.cursor/rules/*.mdc` 四模式 | Memories：自动从聊天生成，per-project（有泄漏争议） | 服务端账号 | alwaysApply 恒注 / globs / 模型自判 | 手工 + 自动 | 描述匹配 + glob | 建议 ~200 行 |
| **Cline** | `.clinerules` | Memory Bank 社区模式（6 个结构化 md，纯 prompt 纪律） | 项目 `memory-bank/` | 指令强制每任务全量读 | 模型按指令全量重写 | 无 | 无硬限制 |
| **Gemini CLI** | GEMINI.md 层级 + JIT 目录扫描 + `@`导入 | 无独立机制：模型直接 write_file 写 md | `~/.gemini/` + 工作区各层 | 随每条 prompt 发送 | 手工 + 模型直写文件 | 无 | 无硬限制 |
| **Windsurf** | `.devin/rules/*.md` 四种 trigger | Cascade memories：自动检测保存、相关时召回 | 本地 per-workspace | 自动召回 + trigger | 自动 + 显式指令 | 自动相关性召回 | 全局 6k 字符 / 规则 12k 字符 |
| **OpenCode / Roo / Continue** | AGENTS.md / rules 目录 | 无 | 项目/全局 | 启动或条件注入 | 手工 | 无 | — |

来源：
- https://code.claude.com/docs/en/memory
- https://github.com/openai/codex/blob/main/docs/agents_md.md
- https://mem0.ai/blog/how-memory-works-in-codex-cli
- https://aider.chat/docs/usage/conventions.html / https://aider.chat/docs/repomap.html
- https://docs.cline.bot/prompting/cline-memory-bank
- https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md
- https://docs.devin.ai/desktop/cascade/memories
- https://opencode.ai/docs/rules/ / https://docs.continue.dev/customize/deep-dives/rules

### 1.1.2 横向规律（对本插件最重要的四条）

1. **人工指令层已收敛**：Markdown 文件 + 层级加载（全局/项目/子目录），AGENTS.md 正成为跨工具公约数。
2. **自动记忆两种形态**：本地 Markdown「索引 + 主题文件」（Claude Code、Codex，可审计、可 git 化）vs 不透明托管记忆库（Cursor、Windsurf，省心但可控性差，且有跨项目泄漏前科）。
3. **检索普遍刻意回避向量 RAG**：主流是「小索引/摘要常驻 + grep/文件工具按需取详情」，把检索变成模型自己的工具调用（progressive disclosure）。
4. **预算都在收紧**：200 行、25KB、32KiB、6k/12k 字符——常驻上下文越小，模型遵循度越高。

## 1.2 通用记忆框架

| 框架 | 存储 | 写路径 | 读路径 | 冲突处理 | 亮点 |
|---|---|---|---|---|---|
| **Mem0** | 向量库（Mem0ᵍ 用 Neo4j 三元组） | LLM 抽取管线：每轮抽取候选事实 → 向量 top-k 近邻 → LLM 路由 ADD/UPDATE/DELETE/NOOP | always-inject top-k | LLM 路由四选一 | LOCOMO p95 延迟 1.44s（vs 全上下文 17.1s），token 省 90%+ |
| **Zep / Graphiti** | 时序知识图谱（episode→实体事实→社区摘要） | LLM 抽取，**双时态模型**：矛盾时旧边置 invalid 而非删除 | 混合检索（cosine + BM25 + 图 BFS）+ RRF/MMR 重排 | 失效不删除，支持 point-in-time 查询 | LongMemEval 准确率 +18.5%、延迟 -90% |
| **Letta（前 MemGPT）** | 三层：core（常驻 block）/ recall（对话历史）/ archival（向量库） | **agent 工具调用自编辑**（`core_memory_append/replace`） | core 常驻 + agent 自主调搜索工具 | agent 自己判断 | 自编辑记忆、sleep-time 巩固；代价是 token 开销高 |
| **LangMem** | LangGraph BaseStore，可插拔 | 双模：hot-path 工具 + 后台异步 manager | 工具召回 | 后台 consolidation 合并矛盾 | 唯一显式支持 procedural memory（改写 system prompt）；pre-1.0，p95 检索延迟报告偏高 |
| **cognee** | 图+向量（LanceDB/Kuzu/Neo4j 可插拔） | ECL 管线（Extract→Cognify→Load） | `recall` API / MCP | — | 把文档变知识图谱，本地默认栈 SQLite+LanceDB+Kuzu 零服务 |
| **A-MEM** | Zettelkasten 笔记网络 | LLM 生成结构化笔记 + 自动建立链接 + 触发邻居演化 | embedding + 沿链接扩展 | 演化式更新 | 自组织知识网络；写侧多次 LLM 调用，静默重写有审计风险 |
| **MemoryOS** | 三级：STM→MTM→LPM | FIFO 晋升 + 热度置换 | 分段召回 | 热度驱逐 | 「OS 内存管理」工程化隐喻，热度 = 访问次数+交互长度+近期度 |
| **ChatGPT** | Saved memories + Reference chat history | 2025 起 "Dreaming" 后台跨会话合成 | 蒸馏摘要注入（非 RAG） | 后台合并 | 社区逆向结论：核心是「数百次对话蒸馏成密集摘要」，无向量库 |

来源：
- Mem0: https://arxiv.org/html/2504.19413v1
- Zep: https://arxiv.org/abs/2501.13956
- MemGPT/Letta: https://arxiv.org/abs/2310.08560
- LangMem: https://www.digitalocean.com/community/tutorials/langmem-sdk-agent-long-term-memory
- cognee: https://github.com/topoteretes/cognee
- A-MEM: https://arxiv.org/abs/2502.12110
- MemoryOS: https://arxiv.org/abs/2506.06326
- ChatGPT memory 逆向: https://www.shloked.com/chatgpt-memory

## 1.3 设计模式与学术共识

- **分类学（CoALA, arXiv:2309.02427）**：working（上下文窗口）/ episodic（经历）/ semantic（事实）/ procedural（怎么做）。编码 agent 中 procedural 价值最高（"这个仓库怎么跑测试"）。
- **写策略三派**：every-turn 管线（Mem0，一致性好但每写 1-2 次额外 LLM 调用）；显著性门控（Generative Agents 重要性打分累计超阈值才 reflection）；工具驱动（Letta/LangMem hot-path，零固定开销但依赖模型自觉）。实践收敛于**混合**：热路径工具写 + 可选后台巩固。
- **检索评分事实标准（Generative Agents, arXiv:2304.03442）**：`score = α·recency + β·importance + γ·relevance`，recency 指数衰减，importance 写入时 LLM 打分，relevance 余弦相似度。
- **巩固**：重活放异步/睡眠时（Letta sleep-time、ChatGPT dreaming、LangMem background manager），热路径只读。
- **遗忘**：软衰减（recency 降权）+ 硬失效（Zep 双时态 invalid、supersede 而非删除）。
- **文件 vs 数据库**：实践收敛于混合——小的策展文件常驻 + 大库按需检索。文件派白送可读、可 diff、可 git 审计。
- **本地 embedding 标准栈**：fastembed（BGE-Small 384d，ONNX，无 PyTorch）+ sqlite-vec（单文件，10 万级 KNN <100ms）。注意 sqlite-vec 必须用 `WHERE embedding MATCH ? AND k = N` 写法，否则全表扫描慢 ~190 倍。
- **记忆投毒**（arXiv:2601.05504、Unit42）：恶意内容经抽取进入持久记忆跨会话生效，MINJA 类注入成功率 >95%。最便宜的三层防御：写入侧来源标记（user-stated / inferred / external）、工具输出原文不直接入库（先蒸馏）、注入时附来源与时间让主模型自判可信度。

## 1.4 调研结论 → 12 条设计要点

1. **文件为真相，向量为索引**：markdown 文件是唯一持久化事实源（可读、可 diff、可 git），sqlite-vec 只存派生索引，可随时重建。
2. **索引常驻 + 详情按需取**（progressive disclosure）：MEMORY.md 式小索引（指针 + 一行摘要，≤1-2k token）常驻注入；正文靠 recall 工具拉取。不赌纯向量召回——关键事实走常驻注入。
3. **三级作用域用目录表达**：global（`~/.dsh/storages/` 下）→ project（可入 git）→ session（易失，结束评估晋升）；project 覆盖 global。
4. **按 CoALA 分目录**：`facts/`（semantic）、`episodes/`（会话案例）、`procedures/`（可复用流程，编码 agent 价值最高）。
5. **写路径混合**：热路径工具驱动写（Letta 模式，零固定开销）+ 可选 salience 门控的自动捕获（默认保守、可关）。
6. **冲突「失效不覆盖」**：旧条目标 `superseded_by` frontmatter，保留历史可查；索引只放有效条目。
7. **检索评分**：`relevance × recency_decay + importance` 简化三因子；无向量时退化为 frontmatter 关键词 + recency。
8. **向量可选**：fastembed + sqlite-vec 为可选增强，未安装退化为全文/关键词检索，功能降级不失败。
9. **写前信任检查**：frontmatter 强制 `source` 字段；工具输出/外部抓取中的指令性文本（"以后总是……"）降权或拒写。
10. **每条记忆带元数据**：`created / last_confirmed / scope / type / source`，注入时附时间信息。
11. **预算硬护栏**：常驻注入 token 上限可配，超限按分截断并明示「已折叠 N 条，可用 recall 查」，绝不静默丢弃。
12. **可观测性**：写/改/失效全部是可读 markdown diff（配合 git 即审计日志）；自定义 session 事件全部 log-only。

---

# Part 2 · 开发计划

## 2.1 定位与目标

dsh 核心目前**没有任何 memory 功能**（已全量确认），本插件填真空地带。

- **名称**：`dsh-code-memory`（包名建议 `@dsh-tui-ecosystem/dsh-code-memory`）
- **形态**：标准 cordis 运行时插件（纯 ESM，三导出），通过 `dsh plugin --profile dsh-tui add` 安装，对 dsh 核心与 dsh-TUI **零侵入**（不改对方一行代码）。
- **核心能力**：
  1. 跨会话持久记忆（global / project / session 三级）
  2. 会话启动 + prompt 提交时的自动召回注入
  3. agent 自主记忆工具（模型主动记/查/改）
  4. `/memory` 斜杠命令（TUI 内浏览、增删、开关）
  5. 压缩（compaction）前的关键上下文抢救
- **非目标（v1 不做）**：跨机同步、团队共享服务端、知识图谱、自动后台 LLM 巩固管线（留接口，v2 再做）。

## 2.2 dsh 平台接线点（已核实的 API）

### 2.2.1 插件骨架

```ts
// src/index.ts —— cordis 插件三导出
export const name = 'dsh-code-memory'
export const Config = Schema.object({ ... })   // @deepseek-ai/schemastery
export function apply(ctx: Context, config: Config): void { ... }
```

打包：`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，patch 内容：

```yaml
- insert:
    - id: code-memory
      name: '@dsh-tui-ecosystem/dsh-code-memory'
      # config: {...}   # 默认配置，用户可在 profile 的 cordis.patch.yml 覆写
```

安装即 `dsh plugin --profile dsh-tui add <pkg>`，reconcile 自动入层栈。用户覆写放 `~/.dsh/profiles/dsh-tui/cordis.patch.yml`（注意：同 id 行是**整块替换**，文档里要提醒用户复述全部键）。

### 2.2.2 事件与注入通道映射

| 功能 | 接线点 | 模式 |
|---|---|---|
| **Recall（prompt 提交时）** | `ctx.on('agent/pre-step', ...)` | **waterfall**：返回 `{kind:'enter', messages: [...payload.messages, recallMsg]}` 追加召回消息 |
| **会话启动召回** | `ctx.on('agent/session-start', ...)` | emit；用 `agent.inject(message)` 播种（source 含 startup/resume/clear/compact） |
| **Capture（响应后）** | `ctx.on('session/event', ...)` | emit；过滤 `user/message`、`assistant/message`、`turn/end` |
| **压缩前抢救** | `ctx.on('session/event')` 过滤 `compaction/start` | emit；把将丢失的决策/未解决问题写入记忆 |
| **轻量常驻注入** | `ctx.systemPrompt.context({name, order, text})` | 动态上下文，每次 assembly 求值——注入 MEMORY 索引 |
| **斜杠命令** | `ctx.commands.register({name:'memory', handler})` | 返回 `{kind:'success', text}`，TUI 直接渲染 text |
| **TUI 补全** | `ctx.tuiCommandTrees.register({root:'memory', children, descriptions})` | 子命令树提示 |
| **持久化** | `ctx.storage.domain.open({name:'memory', version:1, tables})` | 落 `~/.dsh/storages/`，带 zod schema 与 `domain/changed` 事件 |
| **生命周期清理** | `ctx.on('session/disposed')` + `ctx.effect(() => cleanup)` | per-session 状态随 fiber 释放 |

召回消息构造（dsh-llm 原生为 memory 预留的形式）：

```ts
createUserMessage({
  content: renderedRecall,
  source: { kind: 'plugin', plugin: 'dsh-code-memory', form: 'recall' },
})
```

### 2.2.3 红线（必须遵守）

1. **自定义 session 事件类型必须先注册**进每个可达副本的 `KNOWN_SESSION_EVENT_TYPES`（锚点 `import.meta.url` + `process.argv[1]`，createRequire 解析，幂等），否则会话无法 resume。参考实现：`dsh-working-activity/src/registration.ts`。
2. 自定义事件全部 log-only（不带 SurfaceIntent），模型不可见。
3. 类型声明合并：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'memory/captured': Payload } }`。
4. 不追 surface 事件、不写 stdout（属于 TUI）；调试走 stderr + `DSH_TUI_DEBUG`。
5. pnpm 隔离布局陷阱：传递依赖不会链接进 profile 根，跨 bundle 引用要走宿主包子路径导出。

## 2.3 插件架构

```
dsh-code-memory
├── src/
│   ├── index.ts            # 三导出 + 事件接线（薄壳）
│   ├── registration.ts     # session 事件类型注册（红线 1）
│   ├── config.ts           # Schemastery Config schema
│   ├── store/
│   │   ├── files.ts        # markdown 文件读写（唯一事实源）
│   │   ├── frontmatter.ts  # YAML frontmatter 解析/序列化 + zod 校验
│   │   ├── index-file.ts   # MEMORY.md 索引生成与裁剪（预算护栏）
│   │   └── vector.ts       # 可选：sqlite-vec 派生索引（懒加载，失败降级）
│   ├── recall/
│   │   ├── scorer.ts       # relevance × recency_decay + importance
│   │   ├── keyword.ts      # 无向量时的关键词/全文检索
│   │   └── render.ts       # 召回结果渲染为注入文本（带来源/时间标注）
│   ├── capture/
│   │   ├── salience.ts     # 显著性门控（用户纠正/报错解决/显式指令）
│   │   └── extractor.ts    # 事件流 → 候选记忆（v1 规则式，不额外调 LLM）
│   ├── hooks/
│   │   ├── pre-step.ts     # agent/pre-step waterfall 召回注入
│   │   ├── session-start.ts# 启动召回
│   │   ├── capture.ts      # session/event 捕获
│   │   └── compaction.ts   # compaction/start 抢救
│   ├── tools.ts            # memory_write / memory_search / memory_forget 工具定义
│   ├── commands.ts         # /memory 命令族 + tuiCommandTrees
│   └── types.ts            # Memory 类型 + SessionEventMap 声明合并
├── cordis.patch.yml
├── package.json
└── docs/
```

数据流：

```
                 ┌──────────── 写路径 ────────────┐
  user/message ─→ salience 门控 ─→ extractor ─→ files.ts ─→ *.md（真相）
  agent 工具调用 memory_write ──────────────────↗     │
  compaction/start 抢救 ────────────────────────↗     ↓ 派生
                                               vector.ts（sqlite-vec，可选）
                 ┌──────────── 读路径 ────────────┐
  session-start ─→ 读 MEMORY.md 索引 ─→ agent.inject()
  pre-step ─→ scorer 召回 top-k ─→ waterfall 追加 recall 消息
  agent 工具调用 memory_search ─→ 全文/向量检索 ─→ 工具结果
```

## 2.4 数据模型

### 2.4.1 记忆文件格式（唯一事实源）

每条记忆一个 markdown 文件，YAML frontmatter：

```markdown
---
id: mem_01JZK…            # ulid
type: fact | episode | procedure
scope: project | global
source: user | agent-inferred | tool-output   # 信任分层（防投毒）
importance: 3             # 1-5，写入时评
created: 2026-08-17T10:00:00Z
last_confirmed: 2026-08-17T10:00:00Z
status: active | superseded
superseded_by: mem_01JZR… # 失效不删除
tags: [build, pnpm]
---

本仓库必须用 pnpm（lockfile 是 pnpm-lock.yaml），npm install 会破坏隔离布局。
```

### 2.4.2 目录布局

```
~/.dsh/memory/                    # global 作用域（用户偏好、跨项目经验）
├── MEMORY.md                     # 常驻索引（≤ 配置 token 上限，超出裁剪并标注）
├── facts/  episodes/  procedures/
<repo>/.dsh/memory/               # project 作用域（仓库约定，可入 git 共享；提供 .gitignore 选项）
├── MEMORY.md
├── facts/  episodes/  procedures/
~/.dsh/storages/memory.json       # storage.domain：索引元数据缓存 + 配置外状态
~/.dsh/storages/memory-vec.db     # 可选：sqlite-vec 派生索引（可删可重建）
session 作用域                     # 进程内 Map，session/disposed 时评估晋升或丢弃
```

project 根定位：复用 dsh 会话按 cwd 编码的既有约定；git 仓库根优先，非 git 目录用 cwd。

### 2.4.3 自定义 session 事件（全部 log-only）

| 事件 | payload | 时机 |
|---|---|---|
| `memory/captured` | `{id, type, scope, source, file}` | 写入/晋升成功 |
| `memory/recalled` | `{ids, query, scores, budget}` | 召回注入后（可观测性核心） |
| `memory/superseded` | `{oldId, newId}` | 冲突失效 |

## 2.5 读写策略（落实 §1.4 设计要点）

### 读路径

1. **会话启动**（`agent/session-start`）：把 global + project 两个 `MEMORY.md` 索引拼接（project 在后、优先），`agent.inject()` 播种。resume/clear/compact 时同样注入（compact 后记忆索引必须回到上下文）。
2. **prompt 提交**（`agent/pre-step`，waterfall）：对用户输入做召回评分，top-k（默认 3）渲染成带 `[source/时间]` 标注的 recall 消息追加。预算超限即截断 + 明示「还有 N 条，可用 memory_search 查」。
3. **模型自主**（工具）：`memory_search(query, scope?, type?)`、`memory_get(id)` 按需取全文。

评分：`score = relevance × exp(-Δdays/30) + 0.2 × (importance/5)`。无向量时 relevance = 关键词命中（frontmatter tags + 全文子串）。

### 写路径

1. **工具驱动（主）**：注册 `memory_write(content, type, scope, tags?)` 工具，system prompt 里用 `systemPrompt.section`（order 100-199 工具引导区）写一段简短的使用纪律（何时记：构建命令、调试结论、用户纠正；何时不记：代码能查到的事实、临时上下文）。
2. **显著性门控捕获（辅，默认开、可关）**：`session/event` 监听中只做规则式检测——用户消息含纠正模式（"不对/应该/记住/以后"）、`tool/result` 长错误后接成功、显式 `/memory add`。命中后**不直接写库**，而是 `agent.inject()` 一条提示让模型自己决定是否调 `memory_write`——避免 v1 引入额外 LLM 调用，也防止工具输出原文直接入库（防投毒要点 9）。
3. **压缩抢救**：`compaction/start` 时同样走门控提示，让模型把「架构决策、未解决问题」先写记忆再被压缩。

### 冲突与更新

`memory_write` 检测到同主题 active 记忆（向量/关键词相似 + 同 scope）时返回冲突提示，模型选择：新条目 + 旧条目置 `status: superseded` / 更新 `last_confirmed` / 放弃。索引只收 active。

## 2.6 命令与 TUI 集成

`/memory` 命令族（handler 返回 text，TUI 直接渲染）：

| 命令 | 行为 |
|---|---|
| `/memory` | 概览：各作用域条数、索引 token 占用、最近写入 |
| `/memory list [scope] [type]` | 列表（id + 一行摘要 + 时间） |
| `/memory add <text>` | 显式写入（source=user，最高信任） |
| `/memory show <id>` / `rm <id>` | 查看 / 删除（真删，区别于 supersede） |
| `/memory search <query>` | 手动检索，展示评分构成 |
| `/memory on` / `off` | 开关自动召回/捕获（写 settings 命名空间） |
| `/memory rebuild` | 从 md 文件重建索引与向量库 |

TUI 侧：`ctx.tuiCommandTrees.register({root:'memory', children(path), descriptions})` 提供子命令补全；不做任何自定义 surface 渲染（v1 全部走 CommandResult.text，天然兼容 TUI）。

## 2.7 配置项（Schemastery schema）

```ts
{
  enabled: true,
  scopes: { global: true, project: true },
  recall: {
    maxTokens: 1200,        // 索引+召回注入总预算硬上限
    topK: 3,
    onSessionStart: true,
    onPreStep: true,
  },
  capture: {
    salienceGated: true,    // 规则门控提示模型记
    compactionRescue: true,
  },
  vector: {
    enabled: 'auto',        // auto: 依赖可用则用，否则降级关键词
    model: 'bge-small',     // fastembed
  },
  projectDir: '.dsh/memory',
}
```

## 2.8 安全设计（记忆投毒防护）

- `source` 三档信任：`user` > `agent-inferred` > `tool-output`；tool-output 来源 v1 只允许经模型蒸馏后由 `memory_write` 写入，永不自动入库。
- 召回注入文本带 `[source, scope, last_confirmed]` 标注，主模型可自判时效与可信度。
- 记忆文件防注入：`memory_write` 内容做指令性模式告警（"忽略之前的指令"等），命中降级为 `agent-inferred` 并在 `/memory list` 中标记。
- project 记忆入 git 前提示用户选择（`.gitignore` 选项），默认 project scope 只在本地。

## 2.9 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 骨架** | package/cordis.patch/config/registration；`ctx.storage.domain` 打通；安装进 dsh-tui profile 能加载不报错 | `dsh plugin add` 后 profile 启动正常 |
| **M2 文件库 + /memory** | files/frontmatter/index-file；`/memory add/list/show/rm/on/off`；MEMORY.md 生成与预算裁剪 | 命令全通；索引超限正确折叠并标注 |
| **M3 召回注入** | session-start 索引注入；pre-step waterfall 关键词召回 + 评分 + 渲染 | 新会话能看到相关记忆；token 预算生效 |
| **M4 工具写 + 门控捕获** | `memory_write/search/get` 工具注册与引导段；salience 门控 inject 提示；compaction 抢救 | 模型在"记住 X"后正确写库；压缩前提示出现 |
| **M5 向量增强（可选）** | sqlite-vec 派生索引 + fastembed；`/memory rebuild`；无依赖降级路径 | 有/无向量两种环境召回均正常 |
| **M6 加固** | 投毒防护、事件注册回归（resume 测试）、文档 | 含 `memory/captured` 事件的会话可正常 resume |

v2 候选：后台 LLM 巩固管线（会话结束异步抽取，参考 LangMem/Mem0）、episodes 自动摘要、跨项目全局经验晋升建议、记忆 diff 的 git 集成。

## 2.10 测试计划

- **单元**：frontmatter 往返、索引裁剪边界（恰好超限）、评分衰减、门控正则。
- **集成（cordis 测试上下文）**：模拟 `agent/pre-step` waterfall 的消息替换；`session/event` 捕获过滤；storage domain 落盘。
- **红线回归**：写入自定义事件后 `ctx.sessionQuery.readSession` 可读、`dsh --resume` 不断。
- **端到端**：真实 dsh-TUI profile 中：记一条 project 记忆 → 新会话召回 → supersede → 索引只剩新条目。
- **降级**：卸载向量依赖后全链路可用。

## 2.11 风险与对策

| 风险 | 对策 |
|---|---|
| 自定义事件类型漏注册导致会话无法 resume | registration.ts 独立模块 + M6 专项回归测试 |
| waterfall pre-step 注入拖慢首 token | 召回全部本地计算（文件/ sqlite），无网络；预算硬上限 |
| 模型不用记忆工具（"该记不记"） | system prompt 工具引导段 + 门控提示兜底 |
| pnpm 隔离布局依赖解析坑 | 依赖全部打进自身 bundle，跨 bundle 引用走子路径导出 |
| 记忆膨胀 | 索引预算护栏 + 单条长度上限 + supersede 机制 |
| cordis/dsh 内部 API 变动 | 只依赖 `.d.ts` 公开类型；接线集中在 hooks/ 便于适配 |
