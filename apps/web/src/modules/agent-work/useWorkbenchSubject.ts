/**
 * 工作台显示主体的组件侧编排（v13 PRD §4.2 C 组）。
 *
 * 与 `workbench-subject.ts` 的分工：那个文件是**纯判定**（无 Vue 依赖、可单测）；
 * 本文件提供组件侧需要的读取与副作用（当前主体是否运行、清空内容、
 * 生成运行中的产物名、确认弹窗），把「判定」和「界面动作」接起来。
 *
 * 两个入口（生成、执行）共用这里，避免各自的拒绝文案与清空顺序分叉。
 */
import { useExecutionStore } from '../../stores/execution'
import { useGenerationFlowStore } from '../../stores/generation-flow'
import { useGlobalChatStore } from '../../stores/global-chat'
import { fileNameForStage } from './workbench-subject'

/**
 * 读取当前显示主体是否仍在运行（PRD M-4 与 B-5 的共同判据）。
 *
 * 按主体种类取各自的运行态；与 `GlobalChatDrawer` 的呼吸点同源，
 * 避免「呼吸点亮着但『清空』可用」这类自相矛盾。
 *
 * @returns 运行中返回 true。
 * @throws 不抛出异常。
 */
export function isSubjectRunning(): boolean {
  const globalChat = useGlobalChatStore()
  const executionStore = useExecutionStore()
  const generationFlow = useGenerationFlowStore()
  const subject = globalChat.subject

  if (!subject) return false
  if (subject.kind === 'generation') return generationFlow.isRunning
  return executionStore.isRunning(subject.skillId)
}

/**
 * 清空当前工作项的内容（PRD C-2：新工作项发起前先清空）。
 *
 * **只清生成内容**：执行记录按 Skill 存放且与 `/agent` 的卡片共享，
 * 删除会让那一边失去数据（技术方案 F19 / R-5）。主体随后由调用方覆盖。
 *
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
export function clearSubjectContent(): void {
  const globalChat = useGlobalChatStore()
  const generationFlow = useGenerationFlowStore()

  if (globalChat.subject?.kind === 'generation') generationFlow.reset()
}

/**
 * 取当前正在生成的产物名（拒绝文案用，PRD C-5 第 ② 条）。
 *
 * 找不到运行中的阶段时退化为 `SKILL.md`——只影响文案措辞，
 * 不影响拒绝本身（拒绝由 `beginSubject` 决定）。
 *
 * @returns 产物文件名。
 * @throws 不抛出异常。
 */
export function activeGenerationFileName(): string {
  const generationFlow = useGenerationFlowStore()
  const runningStage = generationFlow.stages.find(
    (stage) =>
      !['completed', 'failed', 'conflict', 'cancelled'].includes(stage.status),
  )
  return fileNameForStage(runningStage?.kind ?? 'skill')
}

/**
 * 「切换工作项」确认动作（PRD C-5 第 ① 条）。
 *
 * 用浏览器原生确认框，而不是 naive-ui 的 `useDialog`：
 *
 *   1. 本模块同时被 Skill 开发页与结构化用例编辑器使用，两者都在
 *      `n-dialog-provider` 之下，但**测试环境下不挂 provider**；
 *      `useDialog()` 在缺 provider 时直接抛错，会把组件挂载整个打挂。
 *   2. 既有代码在同一位置（v9 的关闭确认、v13 的清空确认）用的就是
 *      `window.confirm`，保持一致。
 *
 * @param message - 确认文案（由 `describeSwitchConfirm` 生成）。
 * @returns 用户同意切换时返回 true。
 * @throws 不抛出异常。
 */
export function confirmSubjectSwitch(message: string): Promise<boolean> {
  return Promise.resolve(window.confirm(message))
}
