/**
 * 验证 Skill 开发报告视图能加载报告，并使用 srcdoc 呈现静态 HTML。
 */
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SkillDevelopmentReportRoute from '../../src/modules/skill-development/routes/SkillDevelopmentReportRoute.vue'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/**
 * 创建挂在报告子路由上的测试宿主。
 * @returns 路由组件包装器。
 * @throws 初始路由无法解析时由 Vue Router 抛出异常。
 */
async function mountReportRoute(): Promise<ReturnType<typeof mount>> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/skill-dev/:skillId/report/:runId',
        component: SkillDevelopmentReportRoute,
      },
    ],
  })
  await router.push('/skill-dev/315bd5bf1/report/20261014-142110')
  await router.isReady()

  return mount(SkillDevelopmentReportRoute, {
    global: { plugins: [router] },
  })
}

describe('SkillDevelopmentReportRoute', () => {
  it('报告加载成功后用 srcdoc 渲染，不再生成会被 CSP 拦截的 blob iframe', async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            '<!doctype html><html><body><main>测试报告内容</main></body></html>',
        }) as Response,
    )
    globalThis.fetch = fetchMock

    const wrapper = await mountReportRoute()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skills/315bd5bf1/test-reports/20261014-142110/report.html',
      { credentials: 'same-origin' },
    )

    const iframe = wrapper.get('iframe')
    expect(iframe.attributes('srcdoc')).toContain('测试报告内容')
    expect(iframe.attributes('src')).toBeUndefined()
    expect(wrapper.text()).not.toContain('正在加载测试报告')

    wrapper.unmount()
  })

  it('报告不存在时显示明确提示，而不是空白 iframe', async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 404 }) as Response)

    const wrapper = await mountReportRoute()
    await flushPromises()

    expect(wrapper.text()).toContain('报告文件不存在')
    expect(wrapper.find('iframe').exists()).toBe(false)

    wrapper.unmount()
  })
})
