/**
 * 测试用例类型定义
 * 前端 调用Agent生成 SKill需要提供的数据对象
 */
export interface ITestCase {
  name: string // 测试用例 名称
  description: string // 测试用例描述
  steps: ITestStep[] // 测试用例步骤
  pwd: string // 测试用例SKILL保存的路径
  url: string // 测试页面地址
  precondition?: string // 测试前置条件 需要执行的skillId
  skillId: string // 测试用例关联的skillId
}

/**
 * 模型信息
 */
export interface IModelInfo {
  name: string // 模型名称
  url: string // 模型地址
  key: string // 模型 key
  /** 是否支持 OpenAI Chat Completions 的 reasoning_effort 参数。 */
  supportsThinking?: boolean
  thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}
