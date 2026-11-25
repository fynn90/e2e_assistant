/**
 * 「工作台是否有任务在运行」的唯一判据（v13 需求 1）。
 *
 * 为什么单独成模块：这个判定被三个地方需要——抽屉的呼吸点与「清空」可用条件、
 * 页签卸载守卫、以及生成/执行的互斥提示。三处若各写一份，口径分叉时会出现
 * 「呼吸点亮着但离开页面不提醒」这类自相矛盾。
 *
 * **范围**：判的是「有任何 Agent 任务在跑」，不只是「显示主体在跑」。
 * 用户离开页签时，即便某个任务不在工作台显示（另一 Skill 的执行），
 * 它同样会因断开而失去观察，因此也要提醒。
 */
import { useExecutionStore } from '../../stores/execution'
import { useGenerationFlowStore } from '../../stores/generation-flow'

/**
 * 判断是否存在正在运行的 Agent 任务。
 *
 * 覆盖两类：
 *   - **生成**：SKILL.md / Playwright 脚本的生成阶段（`generationFlow.isRunning`）；
 *   - **执行**：任一 Skill 上处于「校验中 / 运行中」的执行。
 *
 * @returns 有任务在运行时返回 true。
 * @throws 不抛出异常；需在 Pinia 已激活的上下文中调用。
 */
export function isAnyAgentTaskRunning(): boolean {
  const generationFlow = useGenerationFlowStore()
  const executionStore = useExecutionStore()

  if (generationFlow.isRunning) return true

  return Object.keys(executionStore.records).some((skillId) =>
    executionStore.isRunning(skillId),
  )
}
