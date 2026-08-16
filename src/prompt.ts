/**
 * All model-facing copy in one place: the tool-guidance system-prompt
 * section and the capture nudges. Keep these short — every token here rides
 * every request.
 * @module dsh-code-memory/prompt
 */

/** System-prompt section (order 150, tool-guidance band) teaching memory discipline. */
export const MEMORY_GUIDANCE = `[记忆] 你有跨会话持久记忆（memory_write / memory_search / memory_get 工具）。
主动记录（memory_write）：构建/测试/运行命令、调试结论、仓库约定、用户的纠正与偏好。type：fact=事实，procedure=可复用流程，episode=一次具体经历。scope：project=本仓库（默认），global=跨项目通用。
架构决策（为什么这么选、否决了什么方案）用 fact 记录并打 tag "decision"，写明理由——这是最有长期价值的记忆。
涉及具体代码时带 paths/symbols 参数做锚点（正文写出文件路径也会自动抽取）；锚点让检索更准，也让重构后失效的记忆能被标记出来。
不要记录：代码里能查到的事实、当前任务的临时上下文、任何密钥/令牌/敏感信息。工具输出不要原文入库，先蒸馏成一句结论。
写入返回 conflict 时：新信息更准确就带 supersede=<旧id> 重写；否则放弃本次写入。
召回的记忆标注了来源与确认日期，注意时效；标注"引用路径已失效"的记忆先核实再用；细节用 memory_get 取全文，不要凭摘要臆断。`

/** Salience-gate nudge, injected as a plugin notice when the user corrects/instructs. */
export const CAPTURE_NUDGE = '[memory] 刚才的纠正/指令如果有长期价值（约定、偏好、排错结论），用 memory_write 记一条；一次性上下文不要记。'

/** Error→success nudge, injected when a tool failure was just overcome. */
export const DEBUG_NUDGE = '[memory] 刚才的报错已解决——如果排错过程有可复用的结论（根因、正确命令、坑位），用 memory_write 记一条 procedure。'

/** Compaction rescue nudge: save decisions before the context is compacted away. */
export const COMPACTION_NUDGE = '[memory] 上下文即将压缩。请先把值得跨会话保留的内容用 memory_write 记下：架构决策、未解决的问题、当前进展与下一步。'
