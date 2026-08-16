# dsh-code-memory

dsh（deepseek-harness）的跨会话记忆插件，兼容 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI)（DeepSeek Harness 的终端前端，npm 包 `@deepseek-harness-tui/dsh-tui`）。Markdown 文件是唯一事实源，小索引常驻注入 + 工具按需取详情，零外部服务依赖。

设计与调研依据见 `docs/research-and-plan.md`。

## 能力

- **三级记忆**：global（`~/.dsh/memory/`）/ project（`<git根>/.dsh/memory/`，可入 git）/ session（不落盘）
- **三类记忆**：`facts/`（事实）、`episodes/`（经历）、`procedures/`（可复用流程）；架构决策约定为 fact + tag `decision`
- **代码锚点**：记忆可带 `paths` / `symbols`（写入时模型显式给出，或从正文自动抽取文件路径）；锚点命中按 tag 级权重参与检索，引用的路径全部从磁盘消失时记忆被降权并标注「⚠ 引用路径已失效」（重构腐烂检测）
- **自动召回**：会话启动注入 `MEMORY.md` 索引；每次提问经 `agent/pre-step` waterfall 注入相关记忆（关键词评分 × 时间衰减 + 重要度）；工具报错时用错误文本检索并注入命中的记忆（`via: on-error`，限流）
- **标识符分词**：camelCase / snake_case / 路径分段拆分，中文 query 能命中英文标识符
- **模型自记**：`memory_write` / `memory_search` / `memory_get` 三个工具 + system prompt 使用纪律；冲突走 supersede（失效不删除，历史可查）；`memory_get` 命中即刷新 `lastConfirmed`（读取=确认，阻断单调衰减）
- **门控捕获**：用户纠正/指令、报错解决时轻提示模型考虑记录（不自动写库）；压缩前抢救提示
- **/memory 命令**：`list / add / show / rm / search / stats / compact / on / off / rebuild`（stats=库健康统计，compact=巩固报告：近重复对/失效锚点/长期未确认）
- **防投毒**：`source` 信任分层（user > agent-inferred > tool-output），召回注入带来源与日期标注，工具输出原文永不直接入库

> `.dsh/memory` 入 git 时建议把 `MEMORY.md` 加进 `.gitignore`——它是每次写入后重建的派生物，纳入版本控制只会制造合并冲突；记忆文件本体（`facts/` 等）才值得共享。

## 安装

按 dsh 官方插件安装方式（`dsh plugin` 是对 pnpm 的薄转发，装完自动 reconcile 进 profile 的 bundles 层栈）：

```sh
# 安装到 dsh-tui profile（从 npm registry）
dsh plugin --profile dsh-tui add dsh-code-memory

# 启动 / 重启生效
dsh --profile dsh-tui        # 或 dsh-tui
```

包内 `cordis.patch.yml` 声明了 `dsh.bundle.patch`，安装后无需手改任何配置即完成挂载。

```sh
# 升级 / 卸载（卸载即恢复原状，不留核心补丁）
dsh plugin --profile dsh-tui update dsh-code-memory
dsh plugin --profile dsh-tui remove dsh-code-memory
```

配置覆写：在 `~/.dsh/profiles/dsh-tui/cordis.patch.yml` 用户层按 id `code-memory` 覆写（config 为整块替换，须复述全部键，见下节）。

## 配置（全部有默认值）

```yaml
enabled: true
scopes: { global: true, project: true }
recall: { maxTokens: 1200, topK: 3, onSessionStart: true, onPreStep: true }
capture: { salienceGated: true, compactionRescue: true }   # salienceGated 同时门控报错触发召回
projectDir: '.dsh/memory'
smokeEvent: false   # 仅开发：每会话写一条 dummy memory/captured 验证 resume
```

## 可观测性

全部 log-only session 事件（模型不可见，类型已在所有可达 dsh-session 副本注册，不影响 resume）：

- `memory/captured` — 写入
- `memory/recalled` — 召回注入（via=session-start/pre-step/on-error，含 ids/预算/折叠数）
- `memory/recall-used` — 召回的记忆被 memory_get 跟进（召回质量反馈信号）
- `memory/superseded` — 失效取代

## 开发

```bash
pnpm install
pnpm build     # tsc → lib/
pnpm test      # vitest，66 例
```

红线：新增自定义 session 事件类型时，必须同步加进 `src/registration.ts` 的 `MEMORY_EVENT_TYPES` 和 `src/events.ts` 的 `SessionEventMap` 合并，否则含该事件的会话无法 resume。

## 发版

CI：`ci.yml` 在 main 的 push/PR 上跑 Node 22/24 的 build+test；`release.yml` 在 `v*` tag 上校验版本号一致后发布 npm（provenance）并建 GitHub Release。需要仓库 secret `NPM_TOKEN`（granular token，只允许本包 publish 即可）。

```bash
# 发版 = 提版本号 + 打 tag + 推 tag
pnpm version patch   # 或 minor / major；生成版本提交与 v* tag
git push origin main --follow-tags
```
