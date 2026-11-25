/**
 * 验证结构化用例仅在服务端标准化结果满足生成条件时上报激活里程碑。
 */
import { defineComponent, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { IE2ETestCase } from '@authine-e2e-agent/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  fetchE2ETestCase: vi.fn(),
  updateE2ETestCase: vi.fn(),
}))

vi.mock(
  '../../src/modules/e2e-test-case/services/e2e-test-case-api',
  () => apiMocks,
)
vi.mock('../../src/composables/useGlobalMessage', () => ({
  useGlobalMessage: () => ({ success: vi.fn(), error: vi.fn() }),
}))

import { useE2ETestCase } from '../../src/modules/e2e-test-case/composables/useE2ETestCase'

const baseTestCase: IE2ETestCase = {
  schemaVersion: '1.0',
  id: 'case_login',
  title: '用户登录',
  description: '验证有效用户可以登录。',
  baseUrl: 'https://example.test',
  tags: [],
  preconditions: [],
  steps: [],
}

/**
 * 构建前端编辑器所需的结构化用例文档响应。
 * @param testCase 服务端标准化后的结构化用例。
 * @returns 模拟 API 文档数据。
 * @throws 不抛出异常。
 */
function buildDocument(testCase: IE2ETestCase) {
  return {
    testCase,
    title: testCase.title,
    description: testCase.description,
    version: 'version-1',
    sourceHash: `sha256:${'a'.repeat(64)}`,
    updatedAt: new Date(0).toISOString(),
    script: {
      exists: false,
      status: 'not_generated',
      version: null,
      generatedAt: null,
      updatedAt: null,
      sourceHash: null,
    },
  }
}

interface IOnboardingSaveResult {
  title: string
  description: string
  version: string
  generationReady: boolean
}

/**
 * 在 Vue 组件生命周期中挂载用例 composable。
 * @param onSaved 保存成功回调。
 * @returns composable 实例和用于触发卸载清理的组件包装器。
 * @throws 组件挂载失败时由测试框架抛出异常。
 */
async function mountEditor(onSaved: (data: IOnboardingSaveResult) => void) {
  let editor: ReturnType<typeof useE2ETestCase> | undefined
  const wrapper = mount(
    defineComponent({
      setup() {
        editor = useE2ETestCase(ref('abc123def') as Ref<string>, { onSaved })
        return () => null
      },
    }),
  )

  await editor!.load()
  return { editor: editor!, wrapper }
}

beforeEach(() => {
  apiMocks.fetchE2ETestCase.mockReset()
  apiMocks.updateE2ETestCase.mockReset()
  apiMocks.fetchE2ETestCase.mockResolvedValue({
    data: buildDocument(baseTestCase),
  })
  apiMocks.updateE2ETestCase.mockImplementation(
    (_skillId: string, request: { testCase: IE2ETestCase }) =>
      Promise.resolve({
        data: buildDocument(
          JSON.parse(JSON.stringify(request.testCase)) as IE2ETestCase,
        ),
      }),
  )
})

describe('useE2ETestCase onboarding readiness', () => {
  it('reports a saved draft without steps as not generation ready', async () => {
    const onSaved = vi.fn()
    const { editor, wrapper } = await mountEditor(onSaved)

    const saved = await editor.save()
    expect({
      saved,
      error: editor.errorMessage.value,
      fieldErrors: editor.fieldErrors.value,
    }).toEqual({
      saved: true,
      error: '',
      fieldErrors: {},
    })
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ generationReady: false }),
    )
    wrapper.unmount()
  })

  it('reports a normalized saved case with an enabled complete step as generation ready', async () => {
    const onSaved = vi.fn()
    const { editor, wrapper } = await mountEditor(onSaved)
    editor.draft.value = {
      ...baseTestCase,
      steps: [
        {
          id: 'step_login',
          order: 1,
          description: '输入账号并提交',
          action: '填写登录表单并点击登录',
          expectedResult: '进入工作台',
          testData: {},
          enabled: true,
        },
      ],
    }

    const saved = await editor.save()
    expect({
      saved,
      error: editor.errorMessage.value,
      fieldErrors: editor.fieldErrors.value,
    }).toEqual({
      saved: true,
      error: '',
      fieldErrors: {},
    })
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ generationReady: true }),
    )
    wrapper.unmount()
  })
})
