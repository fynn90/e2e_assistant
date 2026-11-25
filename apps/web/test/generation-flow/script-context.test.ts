/**
 * 脚本生成上下文解析的单元测试（v13 需求 3）。
 *
 * 要防的缺陷：`generation-flow` 的阶段依赖是**模块级单例槽位**，由结构化用例
 * 编辑器在挂载时注入。工作台全局化后，用户可能在「工作台显示 Skill A 的生成」
 * 期间进过 Skill B 的开发页，此时槽位已指向 B。若脚本生成直接读槽位，
 * 会**给错误的 Skill 写脚本**。
 *
 * 覆盖两条分支：
 *   1. 槽位正指向目标 Skill → 直接复用（保留草稿与 dirty 语义）；
 *   2. 槽位指向别的 Skill / 不存在 → 从服务端重读目标 Skill。
 */
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { IE2ETestCase } from '@charlie_deng/e2e-assistant-types'
import { resolveScriptContext } from '../../src/modules/generation-flow/script-context'
import type { IScriptStageOptions } from '../../src/modules/generation-flow/script-stage'

/** 构造一个满足生成条件的用例（字段齐全，校验器不会报错）。 */
function validCase (): IE2ETestCase {
  return {
    schemaVersion: '1.0',
    id: 'case_login',
    title: '用户登录',
    description: '验证登录。',
    baseUrl: 'https://example.test',
    tags: [],
    preconditions: [],
    steps: [
      {
        id: 'step_1',
        description: '打开登录页',
        action: 'navigate',
        target: '/login',
        expectedResult: '进入登录页',
        testData: {},
        enabled: true,
      },
    ],
  } as unknown as IE2ETestCase
}

/** 造一份注入依赖（模拟编辑器已挂载）。 */
function injectedDeps (skillId: string, dirty = true): IScriptStageOptions {
  return {
    skillId: ref(skillId),
    draft: ref(validCase()),
    version: ref('v-injected'),
    sourceHash: ref('sha-injected'),
    script: ref(null),
    dirty: ref(dirty),
    canGenerate: computed(() => true),
    saveTestCase: async () => true,
  }
}

describe('resolveScriptContext（v13 需求 3）', () => {
  it('槽位正指向目标 Skill：直接复用注入依赖，不发请求', async () => {
    const fetchCase = vi.fn()

    const result = await resolveScriptContext({
      skillId: 'skill-a',
      injected: injectedDeps('skill-a'),
      injectedSourceHash: 'sha-injected',
      fetchCase,
    })

    expect(result.loadedFromServer).toBe(false)
    expect(result.sourceHash).toBe('sha-injected')
    expect(result.skillId).toBe('skill-a')
    // 复用注入依赖：保留用户当前的草稿语义（dirty 仍为 true）。
    expect(result.options.dirty.value).toBe(true)
    expect(fetchCase).not.toHaveBeenCalled()
  })

  it('槽位指向**别的** Skill：从服务端重读目标 Skill，不误用槽位', async () => {
    const fetchCase = vi.fn().mockResolvedValue({
      testCase: validCase(),
      version: 'v-from-server',
      sourceHash: 'sha-from-server',
      script: { exists: false, status: 'missing', version: '', updatedAt: '' },
    })

    const result = await resolveScriptContext({
      skillId: 'skill-a',
      // 槽位被后挂载的编辑器覆盖成了 skill-b —— 正是要防的情形。
      injected: injectedDeps('skill-b'),
      injectedSourceHash: 'sha-of-b',
      fetchCase,
    })

    expect(fetchCase).toHaveBeenCalledWith('skill-a')
    expect(result.loadedFromServer).toBe(true)
    expect(result.skillId).toBe('skill-a')
    // 来源哈希必须取自服务端读取的目标 Skill，而不是槽位里那份。
    expect(result.sourceHash).toBe('sha-from-server')
    // 内容刚从磁盘读出，没有未保存改动。
    expect(result.options.dirty.value).toBe(false)
  })

  it('槽位指向别的 Skill 时，阶段用的是**目标** Skill（决定写到哪）', async () => {
    const fetchCase = vi.fn().mockResolvedValue({
      testCase: validCase(),
      version: 'v1',
      sourceHash: 'sha-1',
      script: { exists: false, status: 'missing', version: '', updatedAt: '' },
    })

    const result = await resolveScriptContext({
      skillId: 'skill-a',
      injected: injectedDeps('skill-b'),
      injectedSourceHash: 'sha-of-b',
      fetchCase,
    })

    // 阶段的所有 API 调用都以 options.skillId 为目标（生成 / 保存 / 读既有脚本），
    // 因此它必须是 skill-a。
    expect(result.options.skillId.value).toBe('skill-a')
  })

  it('尚无任何编辑器挂载（injected 为 null）：也从服务端重读', async () => {
    const fetchCase = vi.fn().mockResolvedValue({
      testCase: validCase(),
      version: 'v1',
      sourceHash: 'sha-1',
      script: { exists: false, status: 'missing', version: '', updatedAt: '' },
    })

    const result = await resolveScriptContext({
      skillId: 'skill-a',
      injected: null,
      injectedSourceHash: '',
      fetchCase,
    })

    expect(result.loadedFromServer).toBe(true)
    expect(result.options.skillId.value).toBe('skill-a')
  })

  it('就绪判定与编辑器同源：用例不满足生成条件时 canGenerate 为 false', async () => {
    // 生成校验器的硬性门槛之一是「至少一个启用步骤」；全部停用即不可生成。
    const brokenCase = {
      ...validCase(),
      steps: validCase().steps.map((step) => ({ ...step, enabled: false })),
    } as IE2ETestCase
    const fetchCase = vi.fn().mockResolvedValue({
      testCase: brokenCase,
      version: 'v1',
      sourceHash: 'sha-1',
      script: { exists: false, status: 'missing', version: '', updatedAt: '' },
    })

    const result = await resolveScriptContext({
      skillId: 'skill-a',
      injected: null,
      injectedSourceHash: '',
      fetchCase,
    })

    expect(result.options.canGenerate.value).toBe(false)
  })
})
