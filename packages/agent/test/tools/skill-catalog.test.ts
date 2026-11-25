/**
 * 检索工具（v16）的单元测试：ID 格式前置拦截、宿主结果归一、
 * 错误归一为「可自修复提示」而非抛出。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createListSkillsTool,
  createReadSkillDocumentTool,
  type ISkillCatalogHost,
} from '../../src/tools/skill-catalog'

/** 构造一个可观测的检索宿主替身（v17：补齐四个新方法的最小实现）。 */
function createHost(overrides: Partial<ISkillCatalogHost> = {}): {
  host: ISkillCatalogHost
  listSkills: ReturnType<typeof vi.fn>
  readSkillDocument: ReturnType<typeof vi.fn>
} {
  const listSkills = vi.fn(async () => [])
  const readSkillDocument = vi.fn(async () => ({
    ok: true as const,
    content: '# 用例',
    hasPlaywrightScript: false,
  }))
  return {
    host: {
      listSkills,
      readSkillDocument,
      // v17 新增能力的无害缺省：本测试文件不覆盖它们（各有独立测试）。
      listFiltered: vi.fn(async () => ({ rows: [], total: 0 })),
      readTestCase: vi.fn(async () => ({
        ok: false as const,
        kind: 'not-found' as const,
        message: '未实现',
      })),
      readRunHistory: vi.fn(async () => ({
        ok: false as const,
        kind: 'not-found' as const,
        message: '未实现',
      })),
      ...overrides,
    },
    listSkills,
    readSkillDocument,
  }
}

describe('list_skills', () => {
  it('工作区无用例时如实说明并引导创建', async () => {
    const { host } = createHost()
    const tool = createListSkillsTool(host)

    const result = await tool.execute('call-1', {}, undefined, undefined)

    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('没有任何 e2e 测试用例')
    expect(text).toContain('创建')
    expect(result.details.count).toBe(0)
  })

  it('候选列表携带产物完备性，供模型判断下一步', async () => {
    const { host } = createHost({
      listSkills: async () => [
        {
          id: 'abc123456',
          title: '云7登录',
          description: '登录页端到端',
          hasSkillDocument: true,
          hasPlaywrightScript: false,
        },
      ],
    })
    const tool = createListSkillsTool(host)

    const result = await tool.execute('call-1', {}, undefined, undefined)
    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : ''

    expect(text).toContain('abc123456')
    expect(text).toContain('已有 SKILL.md')
    expect(text).toContain('缺脚本')
    // 多候选的处置要求必须出现在提示里（ID-5）。
    expect(text).toContain('先向用户确认')
  })
})

describe('read_skill_document', () => {
  it('非法 ID 在插件层就被拦下，不触达宿主', async () => {
    const { host, readSkillDocument } = createHost()
    const tool = createReadSkillDocumentTool(host)

    const result = await tool.execute(
      'call-1',
      { skillId: 'Not-An-Id' },
      undefined,
      undefined,
    )

    expect(readSkillDocument).not.toHaveBeenCalled()
    expect(result.details.ok).toBe(false)
    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('九位')
  })

  it('目标不存在时给出自修复方向（先 list_skills）', async () => {
    const { host } = createHost({
      readSkillDocument: async () => ({
        ok: false,
        kind: 'not-found',
        message: '工作区内不存在 ID 为 abc123456 的用例。',
      }),
    })
    const tool = createReadSkillDocumentTool(host)

    const result = await tool.execute(
      'call-1',
      { skillId: 'abc123456' },
      undefined,
      undefined,
    )

    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('list_skills')
    expect(result.details.ok).toBe(false)
  })

  it('成功时返回全文并提示脚本是否存在', async () => {
    const { host } = createHost({
      readSkillDocument: async () => ({
        ok: true,
        content: '# 云7登录\n\n目标 URL：https://example.com',
        hasPlaywrightScript: true,
      }),
    })
    const tool = createReadSkillDocumentTool(host)

    const result = await tool.execute(
      'call-1',
      { skillId: 'abc123456' },
      undefined,
      undefined,
    )

    const text =
      result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('https://example.com')
    expect(text).toContain('已有 test.spec.ts')
    expect(result.details.hasPlaywrightScript).toBe(true)
  })
})
