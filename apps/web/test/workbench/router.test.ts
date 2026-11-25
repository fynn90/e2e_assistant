// 工作台路由测试：验证独立页面、旧地址规范化、元数据与未知路径回退。
import { createMemoryHistory, type Router } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../../src/router'
import { SKILL_DEVELOPMENT_ROUTE_NAMES } from '../../src/router/skill-development-navigation'
import { WORKBENCH_ROUTE_NAMES } from '../../src/router/workbench-navigation'

/**
 * 创建内存路由并完成一次导航。
 * @param location 待访问的应用内地址。
 * @returns 已完成导航的路由实例。
 * @throws 路由导航失败时由 Vue Router 抛出异常。
 */
async function navigateTo(location: string): Promise<Router> {
  const router = createAppRouter(createMemoryHistory())
  await router.push(location)
  await router.isReady()
  return router
}

describe('workbench routes', () => {
  it.each([
    ['/', WORKBENCH_ROUTE_NAMES.skills, '/skills'],
    ['/?section=skills', WORKBENCH_ROUTE_NAMES.skills, '/skills'],
    ['/?section=unknown', WORKBENCH_ROUTE_NAMES.skills, '/skills'],
    ['/?section=config', WORKBENCH_ROUTE_NAMES.config, '/config'],
  ])(
    'canonicalizes %s to its independent route',
    async (input, routeName, fullPath) => {
      const router = await navigateTo(input)

      expect(router.currentRoute.value.name).toBe(routeName)
      expect(router.currentRoute.value.fullPath).toBe(fullPath)
    },
  )

  it('preserves unrelated query parameters and hashes during legacy redirects', async () => {
    const router = await navigateTo('/?section=config&source=bookmark#details')

    expect(router.currentRoute.value.name).toBe(WORKBENCH_ROUTE_NAMES.config)
    expect(router.currentRoute.value.fullPath).toBe(
      '/config?source=bookmark#details',
    )
    expect(router.currentRoute.value.query).toEqual({ source: 'bookmark' })
  })

  it.each([
    ['/skills', WORKBENCH_ROUTE_NAMES.skills, 'skills', 'Skill 管理'],
    ['/config', WORKBENCH_ROUTE_NAMES.config, 'config', '系统配置'],
  ])(
    'resolves %s with workbench layout metadata',
    async (input, routeName, navigationKey, pageTitle) => {
      const router = await navigateTo(input)
      const currentRoute = router.currentRoute.value

      expect(currentRoute.name).toBe(routeName)
      expect(currentRoute.matched).toHaveLength(2)
      expect(currentRoute.meta.workbenchNavigationKey).toBe(navigationKey)
      expect(currentRoute.meta.workbenchPageTitle).toBe(pageTitle)
    },
  )

  it('redirects unknown frontend paths to the Skill page', async () => {
    const router = await navigateTo('/missing/page')

    expect(router.currentRoute.value.name).toBe(WORKBENCH_ROUTE_NAMES.skills)
    expect(router.currentRoute.value.fullPath).toBe('/skills')
  })

  it('keeps the invalid Skill route and canonicalizes the valid legacy address', async () => {
    const invalidRouter = await navigateTo('/skill-dev')
    const validRouter = await navigateTo('/skill-dev/skill-001')

    expect(invalidRouter.currentRoute.value.name).toBe(
      SKILL_DEVELOPMENT_ROUTE_NAMES.invalid,
    )
    expect(validRouter.currentRoute.value.name).toBe(
      SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
    )
    expect(validRouter.currentRoute.value.fullPath).toBe(
      '/skill-dev/skill-001/chat',
    )
    expect(validRouter.currentRoute.value.params.skillId).toBe('skill-001')
  })
})
