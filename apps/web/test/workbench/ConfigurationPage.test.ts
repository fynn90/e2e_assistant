// 配置路由页测试：验证项目目录变化时才使 Skill 列表状态失效。
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type {
  IConfigSummary,
  IUpdateConfigRequest,
} from '@authine-e2e-agent/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ConfigurationPage from '../../src/pages/ConfigurationPage.vue'
import { usePlatformStore } from '../../src/stores/platform'
import { useWorkbenchStore } from '../../src/stores/workbench'

const messageSuccess = vi.hoisted(() => vi.fn())

vi.mock('../../src/composables/useGlobalMessage', () => ({
  useGlobalMessage: () => ({ success: messageSuccess }),
}))

const WorkspaceSummaryCardStub = defineComponent({
  name: 'WorkspaceSummaryCard',
  emits: ['save'],
  template: `
    <section data-testid="configuration-card">
      <button
        data-testid="save-same-directory"
        @click="$emit('save', {
          projectDirectory: '/workspace/old',
          llmApiBaseUrl: 'https://example.test/v1',
          llmModelName: 'test-model'
        })"
      >
        保存原目录
      </button>
      <button
        data-testid="save-new-directory"
        @click="$emit('save', {
          projectDirectory: '/workspace/new',
          llmApiBaseUrl: 'https://example.test/v1',
          llmModelName: 'test-model'
        })"
      >
        保存新目录
      </button>
    </section>
  `,
})

const initialSummary: IConfigSummary = {
  projectDirectory: '/workspace/old',
  llmApiKeyMasked: 'sk-***',
  llmApiBaseUrl: 'https://example.test/v1',
  llmModelName: 'test-model',
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
}

const basePayload: IUpdateConfigRequest = {
  projectDirectory: initialSummary.projectDirectory,
  llmApiBaseUrl: initialSummary.llmApiBaseUrl,
  llmModelName: initialSummary.llmModelName,
}

/**
 * 挂载配置页并返回 Store、保存桩和卡片包装器。
 * @param saved 保存动作是否成功。
 * @returns 测试配置页所需对象。
 * @throws 组件挂载失败时由测试框架抛出异常。
 */
function mountConfigurationPage(saved: boolean) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const platformStore = usePlatformStore()
  const workbenchStore = useWorkbenchStore()
  platformStore.configSummary = { ...initialSummary }
  platformStore.configPath = '/config.json'
  const update = vi
    .spyOn(platformStore, 'update')
    .mockImplementation(async (payload) => {
      if (saved && payload) {
        platformStore.configSummary = {
          ...initialSummary,
          projectDirectory: payload.projectDirectory,
        }
      }

      return saved
    })
  const invalidateSkills = vi.spyOn(workbenchStore, 'invalidateSkills')
  const wrapper = mount(ConfigurationPage, {
    global: {
      plugins: [pinia],
      stubs: {
        NAlert: { template: '<div><slot /></div>' },
        WorkspaceSummaryCard: WorkspaceSummaryCardStub,
      },
    },
  })

  return {
    wrapper,
    update,
    invalidateSkills,
  }
}

describe('ConfigurationPage', () => {
  beforeEach(() => {
    messageSuccess.mockReset()
  })

  it('keeps the Skill cache when the project directory is unchanged', async () => {
    const { wrapper, update, invalidateSkills } = mountConfigurationPage(true)

    await wrapper.get('[data-testid="save-same-directory"]').trigger('click')
    await flushPromises()

    expect(update).toHaveBeenCalledWith(basePayload)
    expect(invalidateSkills).not.toHaveBeenCalled()
    expect(messageSuccess).toHaveBeenCalledWith('平台配置已保存')
  })

  it('invalidates the Skill cache after changing project directory', async () => {
    const { wrapper, invalidateSkills } = mountConfigurationPage(true)

    await wrapper.get('[data-testid="save-new-directory"]').trigger('click')
    await flushPromises()

    expect(invalidateSkills).toHaveBeenCalledTimes(1)
    expect(messageSuccess).toHaveBeenCalledWith('平台配置已保存')
  })

  it('does not invalidate the Skill cache after a failed save', async () => {
    const { wrapper, invalidateSkills } = mountConfigurationPage(false)

    await wrapper.get('[data-testid="save-new-directory"]').trigger('click')
    await flushPromises()

    expect(invalidateSkills).not.toHaveBeenCalled()
    expect(messageSuccess).not.toHaveBeenCalled()
  })
})
