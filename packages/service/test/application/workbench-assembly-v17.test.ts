/**
 * 工作台能力装配（v17 §5.1 的工具矩阵）的单元测试。
 *
 * 装配是本版最容易「漏一件」的地方：工具矩阵从 4 个扩到 14 个，而漏掉一个
 * 工具的症状是**模型在某个场景下无路可走**（例如想发提案却没有工具），
 * 表现得像提示词问题而不是装配问题。因此这里逐项锁定。
 */
import { describe, expect, it } from 'vitest'
import { assembleWorkbenchCapability } from '../../src/application/agent-workbench/workbench-assembly'
import type { IAgentWorkbenchService } from '../../src/application/agent-workbench/workbench-service'
import type { IAgentWorkRuntime } from '../../src/agent-runtime/agent-work-runtime'

/** 最小工作台服务替身：每个宿主工厂返回空对象（装配不校验宿主实现）。 */
function createServiceStub(): IAgentWorkbenchService {
  return {
    createCatalogHost: () => ({}) as never,
    createReadinessHost: () => ({}) as never,
    createViewHost: () => ({}) as never,
    createProposalHost: () => ({}) as never,
    createBatchHost: () => ({}) as never,
    createTestRunnerHost: () => ({}) as never,
    createActionHost: () => ({}) as never,
    runAction: async () => ({ ok: true, message: '' }),
  } as unknown as IAgentWorkbenchService
}

describe('工作台能力装配（v17）', () => {
  it('装配出完整的 14 个工具（漏一个 = 某条路径无路可走）', () => {
    const assembly = assembleWorkbenchCapability({
      sessionId: 's1',
      workspace: '/workspace',
      runtime: {} as IAgentWorkRuntime,
      service: createServiceStub(),
    })

    const names = assembly.tools.map((tool) => tool.name).sort()

    expect(names).toEqual(
      [
        // 检索类（只回数据，不发卡）
        'list_skills',
        'read_skill_document',
        'read_test_case',
        'read_run_history',
        // 体检（不启动运行）
        'check_readiness',
        // 动作与视图
        'propose_action',
        'render_view',
        // 提案（四类共用一条通道，但工具分开以便固定 origin）
        'propose_case_change',
        'propose_case_repair',
        'propose_env_fill',
        'propose_report_cleanup',
        'propose_case_deletion',
        // 执行
        'execute_test',
        'execute_batch',
      ].sort(),
    )
  })

  it('两个「改变用例」的工具是分开的（origin 由工具固定，模型无从混淆，R15）', () => {
    const assembly = assembleWorkbenchCapability({
      sessionId: 's1',
      workspace: '/workspace',
      runtime: {} as IAgentWorkRuntime,
      service: createServiceStub(),
    })

    const names = assembly.tools.map((tool) => tool.name)
    // 用户主动要求变更 → propose_case_change（红线不适用）
    expect(names).toContain('propose_case_change')
    // Agent 分析结论 → propose_case_repair（红线适用，且 evidence 必填）
    expect(names).toContain('propose_case_repair')
    // 合并成一个工具会让模型能自选 origin —— 那等于红线可绕。
    expect(names).not.toContain('propose_case_update')
  })

  it('渲染协议的工具说明写明「不要复述数据」（协议传选择不传数据）', () => {
    const assembly = assembleWorkbenchCapability({
      sessionId: 's1',
      workspace: '/workspace',
      runtime: {} as IAgentWorkRuntime,
      service: createServiceStub(),
    })

    const renderView = assembly.tools.find((tool) => tool.name === 'render_view')
    expect(renderView?.description).toContain('数据由平台自己取')
    expect(renderView?.description).toContain('不要把读到的内容复述进来')
  })

  it('修复工具要求带失败运行编号（G2a 的输入约束）', () => {
    const assembly = assembleWorkbenchCapability({
      sessionId: 's1',
      workspace: '/workspace',
      runtime: {} as IAgentWorkRuntime,
      service: createServiceStub(),
    })

    const proposeAction = assembly.tools.find(
      (tool) => tool.name === 'propose_action',
    )
    expect(proposeAction?.description).toContain('reportRunId')
    expect(proposeAction?.description).toContain('repair-script')
  })

  it('连续执行工具说明「不截断」与「停止终止整个批次」', () => {
    const assembly = assembleWorkbenchCapability({
      sessionId: 's1',
      workspace: '/workspace',
      runtime: {} as IAgentWorkRuntime,
      service: createServiceStub(),
    })

    const executeBatch = assembly.tools.find(
      (tool) => tool.name === 'execute_batch',
    )
    expect(executeBatch?.description).toContain('不会自行截断')
  })

  it('系统提示词区块来自工作台规则（不是别的资源）', () => {
    const assembly = assembleWorkbenchCapability({
      sessionId: 's1',
      workspace: '/workspace',
      runtime: {} as IAgentWorkRuntime,
      service: createServiceStub(),
    })

    // 规则区块里应有 v16 立下的「定位目标：只能用唯一 ID」与 v17 新增的能力域描述。
    expect(assembly.systemPromptSection).toContain('只能用唯一 ID')
    expect(assembly.systemPromptSection).toContain('用例变更')
  })
})
