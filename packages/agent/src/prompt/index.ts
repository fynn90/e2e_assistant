/**
 * 系统提示词注册表：默认导出一个 map，由 resourceLoader 自动注册。
 *
 * map 的 value 约定：
 *   - string：markdown 文件原文（通过 `?raw` 导入）；
 *   - 对象：TS 模块导出的结构化数据（{ content, description? }）。
 *
 * 新增 prompt 只需两步：
 *   1. 在本目录下新建 `<name>.md`（或 `<name>.ts`，default 导出 PromptTsObject）；
 *   2. 在下方的 promptMap 中登记一条。
 */

import authineE2EAgent from './system/authineE2E-agent.md?raw'
import workbenchSection from './sections/workbench.md?raw'
import workbenchThreshold from './sections/workbench-threshold.md?raw'
import { renderCapabilityPromptSection } from './sections/workbench-capabilities'
import type { PromptMap } from '../resources/types'

/** 系统提示词 map：文件名 -> 内容 */
const promptMap: PromptMap = {
  'authineE2E-agent': authineE2EAgent,
  // v16：/agent 工作台规则区块。只在工作台会话中拼接（见 workbench-agent.ts）；
  // SKILL 内的会话看不到它，因此与主提示词分开登记为独立资源。
  workbench: workbenchSection,
  // v17 P 组：信息充分性门槛（PRD §4.1，最高优先级）。与工作台规则分开登记：
  // 门槛是**所有有副作用动作的前置**，将来普通 Chat 若也要用，直接拼即可。
  'workbench-threshold': workbenchThreshold,
  // v17 H3：能力清单。**由 TS 模块派生**而不是另写一份 markdown——
  // 能力卡（toCapabilityViewPayload）与提示词共用同一常量，两处不可能分叉。
  'workbench-capabilities': renderCapabilityPromptSection(),
}

export default promptMap
