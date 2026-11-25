/**
 * 系统 Skill 加载工具。
 *
 * 本模块将 ResourceLoader 中已注册的系统 Skill 暴露为普通 pi-agent-core AgentTool。
 * Skill 正文来自打包期的内存注册表；因此不能通过工作区 read 工具依赖其虚拟 filePath。
 */

import {
  formatSkillInvocation,
  type AgentTool,
} from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { ResourceLoader, resourceLoader } from '../resourceLoader'

/** load_skill 工具接受的参数 Schema。 */
const loadSkillParameters = Type.Object({
  /** 已注册系统 Skill 的名称，可带 .md 或 .ts 扩展名。 */
  name: Type.String({
    description: '要加载的已注册系统 Skill 名称，可带 .md 或 .ts 扩展名。',
  }),
  /** 追加到完整 Skill 指令后的、本次调用特有的补充说明。 */
  additionalInstructions: Type.Optional(
    Type.String({
      description: '可选的本次任务补充说明，会追加到完整 Skill 指令之后。',
    }),
  ),
})

/** load_skill 工具返回的结构化执行详情。 */
export interface LoadSkillToolDetails {
  /** 实际加载到的 Skill 名称。 */
  skillName: string
  /** Skill 的虚拟来源路径，仅用于定位信息，不保证可被工作区文件工具读取。 */
  filePath: string
}

/**
 * 创建用于按需加载已注册系统 Skill 的普通 Agent 工具。
 *
 * @param loader - 系统资源加载器，缺省使用全局内置注册表加载器；注入该参数可隔离测试资源。
 * @returns 可直接配置到 AgentTool[] 的 load_skill 工具。
 * @throws {ResourceNotFoundError} 请求的 Skill 未注册时由 ResourceLoader 透传。
 * @throws {ResourceParseError} 已注册 Skill 的 frontmatter 或模块导出不合法时由 ResourceLoader 透传。
 */
export function createLoadSkillTool(
  loader: ResourceLoader = resourceLoader,
): AgentTool<typeof loadSkillParameters, LoadSkillToolDetails> {
  return {
    name: 'load_skill',
    label: '加载 Skill',
    description:
      '按名称加载系统提示词中已列出的完整 Skill 指令。当任务匹配某个已列出的 Skill 时调用此工具；不要用 read 工具读取 Skill 的 location，因为该路径可能是打包资源的虚拟路径。',
    parameters: loadSkillParameters,
    // Skill 指令需要先进入模型上下文，再执行依赖这些指令的后续工具调用。
    executionMode: 'sequential',
    /**
     * 加载 Skill 并使用 pi-agent-core 标准格式返回完整调用内容。
     *
     * @param toolCallId - 当前工具调用标识；该无状态工具不使用此参数，但保持 AgentTool 标准签名。
     * @param parameters - 已由 loadSkillParameters 校验的 Skill 名称与可选补充说明。
     * @param signal - 取消信号；纯内存加载无法中断，保留该参数以满足 AgentTool 标准签名。
     * @param onUpdate - 流式进度回调；纯内存加载一次完成，无中间进度需要上报。
     * @returns 包含模型可见 Skill 调用文本与加载元数据的工具结果。
     * @throws {ResourceNotFoundError} Skill 名称不存在时透传。
     * @throws {ResourceParseError} Skill 内容不符合系统资源契约时透传。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      // 复用加载器的缓存、名称规范化和错误语义，禁止使用调用方传入的任意文件路径。
      const skill = loader.getSkill(parameters.name)
      const content = formatSkillInvocation(
        skill,
        parameters.additionalInstructions,
      )

      return {
        content: [{ type: 'text', text: content }],
        details: {
          skillName: skill.name,
          filePath: skill.filePath,
        },
      }
    },
  }
}
