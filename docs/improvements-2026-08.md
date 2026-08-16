# dsh-code-memory 改进计划（2026-08）

基于 2026-08-17 对主流编码 agent 记忆方案的调研（Claude Code 生态 / claude-mem、Cline/Roo Memory Bank、mem0 / Zep / Letta、Serena 等代码情报工具、以及 staleness/consolidation 方向的学术实测），对照本插件 M1–M4 现状的差距分析与本轮工作项。

调研详细来源见对话记录；核心结论：

1. **写时去重/裁决优于读时补救**（mem0 ADD/UPDATE/DELETE、STALE 论文的写时裁决）
2. **supersede 不删除 + 时间有效性** 是审计与正确性的最优解（Zep bi-temporal、agent-memory-lab 实测 append-only 54.7% 时间召回陈旧记忆）
3. **衰减周期要匹配领域节奏**：软件工程实测最优半衰期 ~29 天（arXiv 2605.08538，13k 真实 VSCode issue）——本插件的 30 天时间常数恰好命中
4. **被成功使用的记忆应刷新新鲜度**，否则单调衰减至死
5. **巩固（merge/decay/eviction）带来最大质量收益**（Hindsight：58% 存储缩减、97.2% 保留精度）；向量检索在小规模记忆库上收益甚微，优先级低于反腐烂
6. 编码 agent 最高价值的记忆是**架构决策+理由**（Cline/Roo 单列 decisionLog）与**报错根因**（procedure）

本插件已有决策中符合上述共识的：文件唯一事实源、supersede 不删除、source 信任分层、模型蒸馏后才入库、30 天衰减。本轮补差距。

明确不做（本轮）：

- 敏感信息写入拦截（用户决定不做）
- 向量检索（M5 原规划，推迟——当前记忆量级下关键词+锚点足够）
- 知识图谱/实体关系（过重，与文件事实源哲学冲突）
- claude-mem 式全量工具输出自动捕获（噪声大，保持门控 nudge 路线）

## 工作项

### W1 代码锚点：paths / symbols

**问题**：记忆只有 tags，没有代码实体锚点。文件改名/函数重构后记忆腐烂但照常召回——这是代码记忆最大的失效模式。

**改动**：

- `types.ts` frontmatter 增加 `paths: string[]`、`symbols: string[]`（zod default []，旧文件兼容）
- `memory_write` 工具增加 `paths` / `symbols` 参数；未显式给 paths 时从内容自动抽取路径形态 token（含 `/` 且带扩展名）
- 召回评分：query token 命中锚点（路径全文/ basename / 分段、符号及其 camelCase 子词）按 tag 级权重计分
- 失效检测：`paths` 全部在磁盘上不存在 → 评分降权 ×0.5，召回渲染与 `/memory show` 标注「⚠ 引用路径已失效」

### W2 标识符分词

**问题**：tokenizer 把 `loginHandler`、`foo_bar` 当单一 token，中文 query「登录处理」永远匹配不到。

**改动**：`tokenize` 保留大小写提取，对 latin token 做 `_-./` 分隔与 camelCase 边界拆分，原 token 与子词（小写化，长度≥2）都入 token 流。

### W3 lastConfirmed 刷新

**问题**：衰减挂在 `lastConfirmed` 上，但无任何路径更新它——记忆一经写入单调衰减至死。

**改动**：`store.touch(id, cwd)`（重写 frontmatter + 索引 + 镜像）；`memory_get` 命中时调用。读取即确认，成本一次小文件写。

### W4 报错触发召回

**问题**：pre-step 召回只在用户新输入时跑；编码场景最高价值时刻是工具报错时（「这个错上次见过，根因是 X」正是 procedure 的主场）。

**改动**：capture hook 监听 `tool/result` error，取错误文本检索，有相关度足够高的命中时注入 top 1–2 条（`via: 'on-error'`，与 nudge 共用限流节奏，独立计时）。`MemoryRecalledEvent.via` 联合类型加 `'on-error'`。

### W5 召回命中追踪

**问题**：有 `memory/recalled` 事件但没有闭环——不知道召回的记忆有没有被实际使用，无法评估/调参。

**改动**：进程内 `RecallTracker`（session → 召回 id 集合，30 分钟 TTL，session/disposed 清理）；session-start / pre-step / on-error 三路召回都登记；`memory_get` 命中近期召回 id 时追加 `memory/recall-used` 事件（新事件类型，按红线同步注册 `registration.ts` 与 `events.ts` 的 SessionEventMap 合并）。

### W6 `/memory stats` 与 `/memory compact`

**stats**：库健康统计——各 scope/type/source 数量、失效路径条数、长期未确认分布。数据全部来自文件，不读 session 日志。

**compact**（报告型，不自动改）：巩固管线的第一步，输出三类可操作建议——

1. 近重复对（同 scope 正文 token 包含度 |A∩B|/min(|A|,|B|) ≥0.8，或 tag 重叠且 ≥0.6；不用 keywordRelevance——其 body-only 上限 0.5 永远到不了阈值）→ 建议 supersede
2. 引用路径已全部失效的记忆 → 建议确认后 supersede/rm
3. 超 90 天未确认且 importance ≤2 → 建议复审

### W7 小项

- `memory_search` / `store.search` 增加 `tags` 过滤
- 写时冲突规则收窄：原「tag 重叠即冲突」误报多，改为 `相关度≥0.5` 或 `（tag 重叠 且 ≥0.25）`
- system prompt guidance 加 decision 约定：架构决策记 `fact` + tag `decision`，写明理由与被否决方案
- README：说明 MEMORY.md 是派生物，`.dsh/memory` 入 git 时建议 gitignore 之；补新能力与新命令说明

## 验证

- 每个工作项配 vitest 单测（分词拆分、锚点评分、失效降权、touch、冲突规则收窄、compact 报告、tracker 命中）
- `pnpm build && pnpm test` 全绿
- 红线复查：新增 session 事件类型仅 `memory/recall-used` 一个，三处（registration / events / 本文件）同步
