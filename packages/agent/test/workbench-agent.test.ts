/**
 * 工作台 Agent 与 SKILL 内 Agent 的分工测试（v16）。
 *
 * 本文件锁的是**两个 Agent 的边界**，不是它们各自的内部实现：
 *   - 工作台会话必须拿到检索/执行/动作工具与工作台规则；
 *   - SKILL 内的会话**不得**拿到工作台规则与工作台工具；
 *   - 两者的技能清单与提示词必须不同源。
 *
 * 这些断言的存在理由：两者曾经共用一个工厂、靠运行时 `if` 分支区分，
 * 结果「某能力属于哪个场景」随时间变得不可查。现在按 operateType 分派，
 * 边界必须是编译期可见且被测试锁住的。
 */
import { describe, expect, it } from 'vitest'
import { AgentFactory } from '../src/agents/factory'
import {
  createWorkbenchAgentConfig,
  type IWorkbenchAgentCapability,
} from '../src/agents/workbench-agent'
import { createAuthineE2EAgentConfig } from '../src/agents/authineE2E-agent'

const WORKSPACE = '/tmp/authine-ws'

/** 构造一份最小的工作台能力装配。 */
function createCapability(
  overrides: Partial<IWorkbenchAgentCapability> = {},
): IWorkbenchAgentCapability {
  return {
    systemPromptSection: '## 工作台规则\n唯一 ID 指代目标。',
    tools: [
      { name: 'list_skills' } as never,
      { name: 'execute_test' } as never,
    ],
    ...overrides,
  }
}

describe('AgentFactory 按 operateType 分派', () => {
  it('workbench 类型产出工作台配置（提示词含工作台规则、工具含检索能力）', () => {
    const config = AgentFactory(
      'workbench',
      WORKSPACE,
      'session-1',
      undefined,
      undefined,
      { ...createCapability(), toolGuard: { id: 'guard' } },
    )

    expect(config.systemPrompt).toContain('工作台规则')
    expect(config.tools.map((tool) => tool.name)).toContain('list_skills')
  })

  it('chat 类型不产出工作台规则与工作台工具', () => {
    const config = AgentFactory('chat', WORKSPACE, 'session-2')

    expect(config.systemPrompt).not.toContain('工作台规则')
    const names = config.tools.map((tool) => tool.name)
    expect(names).not.toContain('list_skills')
    expect(names).not.toContain('execute_test')
    expect(names).not.toContain('propose_action')
    // SKILL 内的会话仍拿到文件能力与技能加载能力。
    expect(names).toContain('load_skill')
    expect(names).toContain('read')
  })

  it('workbench 类型缺少能力装配时立即失败（编排缺陷早暴露）', () => {
    expect(() => AgentFactory('workbench', WORKSPACE, 'session-3')).toThrow(
      /工作台会话缺少能力装配/,
    )
  })

  it('默认（省略 operateType）按 chat 处理，保持既有调用方行为', () => {
    const config = AgentFactory(undefined as never, WORKSPACE, 'session-4')
    expect(config.systemPrompt).not.toContain('工作台规则')
  })
})

describe('提示词与技能清单的分工', () => {
  it('工作台提示词含工作台规则，且工作区路径被注入', () => {
    const config = createWorkbenchAgentConfig(
      WORKSPACE,
      '2026-09-30T00:00:00.000Z',
      undefined,
      createCapability(),
    )

    expect(config.systemPrompt).toContain('工作台规则')
    expect(config.systemPrompt).toContain(WORKSPACE)
  })

  it('SKILL 内 Agent 的提示词不含工作台规则', () => {
    const config = createAuthineE2EAgentConfig(
      WORKSPACE,
      '2026-09-30T00:00:00.000Z',
    )

    expect(config.systemPrompt).not.toContain('工作台规则')
  })

  it('工作台技能清单不含「生成文档」类技能（生成须走平台链路，见 ID-7）', () => {
    const config = createWorkbenchAgentConfig(
      WORKSPACE,
      '2026-09-30T00:00:00.000Z',
      undefined,
      createCapability(),
    )

    // 工作台能加载「执行」技能（定位 + 发起执行）。
    expect(config.systemPrompt).toContain('test_script_execution')
    // 但不应把「根据用例数据生成文档」的指令交给工作台模型——
    // 那属于平台编排的子会话（GEN-5）。
    expect(config.systemPrompt).not.toContain('test_case_Skill_document')
    expect(config.systemPrompt).not.toContain('playwright_script_generation')
  })

  /**
   * 带 sessionId 创建配置：唯一会走到「按会话解析浏览器宿主」的路径。
   *
   * 该分支曾因遗漏 `browserSessionRegistry` 的 import 而抛 ReferenceError，
   * 使工作台会话创建**全部失败**（路由 500），四种意图一条都走不通。
   * 路由创建会话时 sessionId 恒为真 UUID，因此这条路径是必经之路，
   * 必须有用例覆盖——不能只在 sessionId 为 undefined 时测。
   */
  it('带会话 ID 创建配置不抛错（浏览器宿主解析路径必经）', () => {
    const config = createWorkbenchAgentConfig(
      WORKSPACE,
      '2026-09-30T00:00:00.000Z',
      // 未登记宿主的会话：浏览器工具应为空数组，但配置本身必须成功产出。
      '0192f3a4-0000-7000-8000-000000000000',
      createCapability(),
    )

    expect(config.systemPrompt).toContain('工作台规则')
    const names = config.tools.map((tool) => tool.name)
    // 未登记浏览器宿主的会话拿不到浏览器工具（PRD 4.2：按会话授权注入）。
    expect(names.filter((name) => name.startsWith('browser_'))).toEqual([])
    // 调用方注入的工作台专有工具原样在场（本用例的装配只给了这两个）。
    expect(names).toContain('list_skills')
    expect(names).toContain('execute_test')
    // 通用文件能力也在场（其边界由 CLI 侧守卫逐次判定）。
    expect(names).toContain('read')
    expect(names).toContain('bash')
  })
})
