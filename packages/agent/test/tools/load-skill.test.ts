/**
 * load_skill 工具单元测试。
 *
 * 本模块验证工具复用 ResourceLoader 解析系统 Skill，并通过 pi-agent-core 的标准
 * formatSkillInvocation 输出完整调用内容；同时覆盖缺失资源和 E2E Agent 集成场景。
 */

import { formatSkillInvocation } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'
import { ResourceLoader, ResourceNotFoundError } from '../../src/resourceLoader'
import type { ResourceRegistry } from '../../src/resources/types'
import { createAuthineE2EAgentConfig } from '../../src/agents/authineE2E-agent'
import { createLoadSkillTool } from '../../src/tools/load_skill'

/** 仅包含 load_skill 所需资源的测试注册表。 */
const fixtureRegistry: ResourceRegistry = {
  prompts: [],
  skills: [
    {
      format: 'md',
      name: 'fixture-skill',
      raw: '---\ndescription: 用于验证按需加载的测试 Skill\n---\n请执行测试 Skill 正文。',
    },
  ],
}

/**
 * 从工具执行结果中获取唯一的文本内容。
 *
 * @param result - load_skill 工具的执行结果。
 * @returns 模型可见的完整 Skill 调用文本。
 * @throws {Error} 当工具没有返回文本内容时抛出，避免测试错误地读取 undefined。
 */
function getResultText(result: { content: Array<{ type: string }> }): string {
  const textContent = result.content.find(
    (content): content is { type: 'text'; text: string } =>
      content.type === 'text' && 'text' in content,
  )
  if (!textContent) {
    throw new Error('load_skill 未返回文本内容')
  }
  return textContent.text
}

describe('createLoadSkillTool', () => {
  /** 每个测试共享独立资源加载器，避免使用默认注册表影响断言。 */
  const loader = new ResourceLoader(fixtureRegistry)

  it('使用 pi 标准格式加载已注册的 Skill', async () => {
    const tool = createLoadSkillTool(loader)
    const skill = loader.getSkill('fixture-skill')

    const result = await tool.execute('tool-call-1', {
      name: 'fixture-skill',
    })

    expect(getResultText(result)).toBe(formatSkillInvocation(skill))
    expect(result.details).toEqual({
      skillName: 'fixture-skill',
      filePath: 'src/skills/fixture-skill.md',
    })
  })

  it('允许携带扩展名并向 Skill 正文追加本次调用说明', async () => {
    const tool = createLoadSkillTool(loader)
    const skill = loader.getSkill('fixture-skill')

    const result = await tool.execute('tool-call-2', {
      name: ' fixture-skill.md ',
      additionalInstructions: '本次仅生成登录场景。',
    })

    expect(getResultText(result)).toBe(
      formatSkillInvocation(skill, '本次仅生成登录场景。'),
    )
  })

  it('透传 ResourceLoader 的未注册 Skill 错误', async () => {
    const tool = createLoadSkillTool(loader)

    await expect(
      tool.execute('tool-call-3', { name: 'missing-skill' }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })
})

describe('createAuthineE2EAgentConfig', () => {
  it('注册 load_skill 并在系统提示词中说明虚拟路径加载约定', async () => {
    const config = createAuthineE2EAgentConfig(process.cwd(), '2026-08-13')
    const toolNames = config.tools.map((tool) => tool.name)
    const loadSkillTool = config.tools.find(
      (tool) => tool.name === 'load_skill',
    )

    expect(toolNames).toEqual([
      'load_skill',
      // v12-pre：多步骤任务清单对所有场景开放（不读写文件、不访问页面）。
      'todo_write',
      'bash',
      'read',
      'write',
      'edit',
    ])
    expect(config.systemPrompt).toContain('## Skill 加载约定')
    expect(config.systemPrompt).toContain('调用 `load_skill`')
    expect(config.systemPrompt).toContain('不要使用 `read` 工具直接读取')
    expect(config.systemPrompt).toContain('test_case_Skill_document')

    if (!loadSkillTool) {
      throw new Error('Authine E2E Agent 未注册 load_skill 工具')
    }

    const result = await loadSkillTool.execute('tool-call-4', {
      name: 'e2e_test_case',
    })
    expect(getResultText(result)).toContain('<skill name="e2e_test_case"')

    const documentResult = await loadSkillTool.execute('tool-call-5', {
      name: 'test_case_Skill_document',
    })
    expect(getResultText(documentResult)).toContain(
      '<skill name="test_case_Skill_document"',
    )
  })
})
