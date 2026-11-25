/**
 * 工作台规则提示词区块的构造入口（v16）。
 *
 * 为什么要一层薄封装：规则正文是打包资源（`prompt/sections/workbench.md`），
 * 通过 `?raw` 导入后由 `resourceLoader` 注册；CLI 组合根在装配会话能力时
 * 需要拿到渲染完成的文本。直接把资源读取写进 CLI 会让应用层依赖 agent 包的
 * 资源目录结构，因此在此收口（单一职责：资源的读取方式只有这一处知道）。
 */

import { resourceLoader } from '../resourceLoader'

/** 工作台规则区块的资源名（与 prompt/index.ts 的登记键一致）。 */
const WORKBENCH_SECTION_RESOURCE = 'workbench'

/** P 组：信息充分性门槛区块的资源名（v17 §5.2，最高优先级）。 */
const WORKBENCH_THRESHOLD_RESOURCE = 'workbench-threshold'

/**
 * 读取工作台规则区块的提示词文本。
 *
 * 文本中不含运行期模板变量（工作区路径由主提示词负责注入），因此可安全缓存复用。
 *
 * @returns 工作台规则区块的 markdown 文本。
 * @throws {ResourceNotFoundError} 资源未登记时抛出（属装配错误，应在启动期暴露）。
 */
export function getWorkbenchPromptSection(): string {
  return resourceLoader.getPrompt(WORKBENCH_SECTION_RESOURCE)
}

/**
 * 读取 P 组（信息充分性门槛）区块的提示词文本（v17 §5.2）。
 *
 * 位置紧接主提示词之后、能力清单之前——**门槛优先于能力**：先决定「能不能动手」，
 * 再谈「能做什么」。拼接顺序见 `workbench-agent.ts`。
 *
 * @returns P 组区块的 markdown 文本。
 * @throws {ResourceNotFoundError} 资源未登记时抛出（属装配错误，应在启动期暴露）。
 */
export function getWorkbenchThresholdSection(): string {
  return resourceLoader.getPrompt(WORKBENCH_THRESHOLD_RESOURCE)
}
