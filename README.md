# dsh-code-memory

dsh（deepseek-harness）的跨会话记忆插件。Markdown 文件是唯一事实源，小索引常驻注入 + 工具按需取详情，零外部服务依赖。

设计与调研依据见 `docs/research-and-plan.md`。

## 能力

- **三级记忆**：global（`~/.dsh/memory/`）/ project（`<git根>/.dsh/memory/`，可入 git）/ session（不落盘）
- **三类记忆**：`facts/`（事实）、`episodes/`（经历）、`procedures/`（可复用流程）
- **自动召回**：会话启动注入 `MEMORY.md` 索引；每次提问经 `agent/pre-step` waterfall 注入相关记忆（关键词评分 × 时间衰减 + 重要度）
- **模型自记**：`memory_write` / `memory_search` / `memory_get` 三个工具 + system prompt 使用纪律；冲突走 supersede（失效不删除，历史可查）
- **门控捕获**：用户纠正/指令、报错解决时轻提示模型考虑记录（不自动写库）；压缩前抢救提示
- **/memory 命令**：`list / add / show / rm / search / on / off / rebuild`
- **防投毒**：`source` 信任分层（user > agent-inferred > tool-output），召回注入带来源与日期标注，工具输出原文永不直接入库

## 安装

```bash
# 本地开发
dsh plugin --profile dsh-tui add link:../dsh-code-memory
```

包内 `cordis.patch.yml` 自动把插件挂进 profile 层栈。配置覆写在 `~/.dsh/profiles/<name>/cordis.patch.yml` 用户层按 id `code-memory` 整块替换（须复述全部键）。

## 配置（全部有默认值）

```yaml
enabled: true
scopes: { global: true, project: true }
recall: { maxTokens: 1200, topK: 3, onSessionStart: true, onPreStep: true }
capture: { salienceGated: true, compactionRescue: true }
projectDir: '.dsh/memory'
smokeEvent: false   # 仅开发：每会话写一条 dummy memory/captured 验证 resume
```

## dsh-TUI 兼容说明

dsh-TUI 的 `Chat.tsx` 本地命令 switch 里有一个 `/memory` 占位 case（显示"DSH 暂无持久记忆服务"），会先于插件命令命中。需要把该 case 改为：**`channel.commandList` 里存在 external 的 `memory` 命令时，走 default 分支的 `channel.runExternalCommand` 派发，否则保持占位提示**——与本插件注册的全局 `memory` 命令即完成对接，TUI 补全已由插件经 `tuiCommandTrees` 提供。

## 可观测性

全部 log-only session 事件（模型不可见，类型已在所有可达 dsh-session 副本注册，不影响 resume）：

- `memory/captured` — 写入
- `memory/recalled` — 召回注入（含 via/ids/预算/折叠数）
- `memory/superseded` — 失效取代

## 开发

```bash
pnpm install
pnpm build     # tsc → lib/
pnpm test      # vitest，38 例
```

红线：新增自定义 session 事件类型时，必须同步加进 `src/registration.ts` 的 `MEMORY_EVENT_TYPES` 和 `src/events.ts` 的 `SessionEventMap` 合并，否则含该事件的会话无法 resume。
