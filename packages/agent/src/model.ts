/**
 * Agent 模型运行时工厂。
 *
 * 本模块将平台配置的 IModelInfo 转换为 pi-ai 的 OpenAI Chat Completions
 * 兼容模型和流式调用函数，不依赖任何具体 Agent 实现。
 */

import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  createModels,
  createProvider,
  type Model,
  type ModelThinkingLevel,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { IModelInfo } from './types'

/** OpenAI Chat Completions 兼容服务在 pi-ai 中使用的内部 Provider 标识。 */
const OPENAI_COMPATIBLE_PROVIDER_ID = 'authine-openai-compatible'

/**
 * 未提供模型目录时采用的上下文窗口大小。
 *
 * 设为 100M 以放宽历史压缩触发阈值，保证长会话不因默认值过小而提前裁剪上下文；
 * 实际可用上限仍由对接模型端点决定，需要收紧时通过模型配置覆盖。
 */
const DEFAULT_CONTEXT_WINDOW = 100_000_000

/**
 * 未提供模型目录时采用的单次最大输出 Token 数。
 *
 * 设为 64K 以支撑代码/文档类长输出，避免生成中途因上限过小而截断。
 */
const DEFAULT_MAX_TOKENS = 65_536

/** 未知 Provider 价格时使用的零成本配置，避免生成不可靠的成本数据。 */
const UNKNOWN_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const

/**
 * 支持 OpenAI reasoning_effort 参数时可使用的 pi-ai 思考等级映射。
 *
 * 显式声明 xhigh 与 max，避免 pi-ai 因默认兼容策略将它们钳制到较低等级。
 */
const OPENAI_REASONING_LEVEL_MAP = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
} as const

/**
 * 可供 pi-agent-core 创建 Agent 的模型运行时。
 */
export interface IAgentModelRuntime {
  /** 已注册到私有 pi-ai Provider 的模型定义。 */
  model: Model<'openai-completions'>
  /** 可直接传入 pi-agent-core Agent 的流式模型调用函数。 */
  streamFn: StreamFn
  /** 根据模型能力处理后的初始思考等级。 */
  thinkingLevel: ModelThinkingLevel
}

/**
 * 创建单个 OpenAI Chat Completions 兼容模型的 pi-ai 运行时。
 *
 * @param modelInfo - 平台保存的模型名称、API 根地址、密钥与思考能力配置。
 * @returns 包含 pi-ai 模型、已绑定流式调用函数及有效思考等级的独立运行时。
 * @throws {Error} 当前实现不会主动抛出错误；Provider 认证和网络错误会由 pi-ai 流编码返回。
 */
export function createAgentModelRuntime(
  modelInfo: IModelInfo,
): IAgentModelRuntime {
  const supportsThinking = modelInfo.supportsThinking === true
  const thinkingLevel: ModelThinkingLevel = supportsThinking
    ? modelInfo.thinkingLevel
    : 'off'

  const model: Model<'openai-completions'> = {
    id: modelInfo.name,
    name: modelInfo.name,
    api: 'openai-completions',
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: modelInfo.url,
    reasoning: supportsThinking,
    ...(supportsThinking
      ? { thinkingLevelMap: OPENAI_REASONING_LEVEL_MAP }
      : {}),
    // v12-pre：声明图片输入能力，browser_screenshot 的截图才能到达模型。
    // pi-ai 只在 model.input 含 "image" 时把工具结果中的图附给模型，
    // 否则静默丢弃、只发 "(see attached image)" 占位文本。
    // 注意：对接不支持 vision 的兼容端点会在图片请求上报错，影响范围是全部 Agent 功能。
    input: ['text', 'image'],
    cost: UNKNOWN_MODEL_COST,
    // 平台配置未提供模型目录时采用保守默认值，后续可由配置覆盖。
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      // 通用兼容服务通常只识别 system 角色，避免使用 OpenAI 专用 developer 角色。
      supportsDeveloperRole: false,
      // 未明确声明能力时不发送 reasoning_effort，避免破坏普通兼容端点。
      supportsReasoningEffort: supportsThinking,
    },
  }

  const provider = createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: 'Authine OpenAI Compatible',
    baseUrl: modelInfo.url,
    auth: {
      apiKey: {
        name: 'Authine 模型密钥',
        // 密钥仅保存在认证解析闭包中，不能通过 Model 元数据或日志读取。
        resolve: async () => ({
          auth: modelInfo.key ? { apiKey: modelInfo.key } : {},
          source: '平台模型配置',
        }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  })

  // 每次创建独立注册表，避免不同工作区的模型地址或密钥相互污染。
  const models = createModels()
  models.setProvider(provider)

  return {
    model,
    streamFn: models.streamSimple.bind(models) as StreamFn,
    thinkingLevel,
  }
}
