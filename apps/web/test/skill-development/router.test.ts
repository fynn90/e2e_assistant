// Skill 开发路由测试：验证子工作区、旧地址规范化和代码文件路径安全往返。
import { createMemoryHistory, type Router } from 'vue-router'
import { describe, expect, it } from 'vitest'
import { createAppRouter } from '../../src/router'
import {
  createSkillDevelopmentChatLocation,
  createSkillDevelopmentCodeLocation,
  createSkillDevelopmentDefaultLocation,
  createSkillDevelopmentImageLocation,
  parseSkillDevelopmentWorkspaceTarget,
  SKILL_DEVELOPMENT_ROUTE_NAMES,
} from '../../src/router/skill-development-navigation'

/**
 * 创建内存路由并完成一次导航。
 * @param location 待访问的应用内地址或命名路由位置。
 * @returns 已完成导航的路由实例。
 * @throws 路由导航失败时由 Vue Router 抛出异常。
 */
async function navigateTo(
  location: Parameters<Router['push']>[0],
): Promise<Router> {
  const router = createAppRouter(createMemoryHistory())
  await router.push(location)
  await router.isReady()
  return router
}

describe('skill development routes', () => {
  it.each([
    ['/skill-dev/skill-001/chat', SKILL_DEVELOPMENT_ROUTE_NAMES.chat, 'chat'],
    [
      '/skill-dev/skill-001/e2e-test-case',
      SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase,
      'e2e-test-case',
    ],
    [
      '/skill-dev/skill-001/code?path=test.spec.ts',
      SKILL_DEVELOPMENT_ROUTE_NAMES.code,
      'code',
    ],
  ])(
    'resolves %s as a nested workspace route',
    async (input, routeName, panel) => {
      const router = await navigateTo(input)
      const currentRoute = router.currentRoute.value

      expect(currentRoute.name).toBe(routeName)
      expect(currentRoute.matched).toHaveLength(2)
      expect(currentRoute.meta.skillDevelopmentPanel).toBe(panel)
    },
  )

  it('preserves query parameters and hashes while canonicalizing the legacy root', async () => {
    const router = await navigateTo(
      '/skill-dev/skill-001?source=bookmark#details',
    )

    expect(router.currentRoute.value.name).toBe(
      SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
    )
    expect(router.currentRoute.value.fullPath).toBe(
      '/skill-dev/skill-001/chat?source=bookmark#details',
    )
  })

  it.each([
    'main.ts',
    'folder/file name.ts',
    'folder/name#part?.json',
    '目录/测试 文件?.json',
  ])('round-trips the exact code path %s', async (relativePath) => {
    const router = await navigateTo(
      createSkillDevelopmentCodeLocation('skill-001', relativePath),
    )
    const currentRoute = router.currentRoute.value

    expect(currentRoute.query.path).toBe(relativePath)
    expect(parseSkillDevelopmentWorkspaceTarget(currentRoute)).toEqual({
      panel: 'code',
      relativePath,
    })

    if (relativePath.includes('#')) {
      expect(currentRoute.fullPath).toContain('%23')
      expect(currentRoute.hash).toBe('')
    }
  })

  it.each([
    '/skill-dev/skill-001/code',
    '/skill-dev/skill-001/code?path=',
    '/skill-dev/skill-001/code?path=first&path=second',
  ])('rejects an invalid code path from %s', async (input) => {
    const router = await navigateTo(input)

    expect(
      parseSkillDevelopmentWorkspaceTarget(router.currentRoute.value),
    ).toBeUndefined()
  })

  it('解析图片预览面板并保留原始路径', async () => {
    const router = await navigateTo(
      createSkillDevelopmentImageLocation('skill-001', 'baselines/img/log.png'),
    )
    const currentRoute = router.currentRoute.value

    expect(currentRoute.name).toBe(SKILL_DEVELOPMENT_ROUTE_NAMES.image)
    expect(currentRoute.meta.skillDevelopmentPanel).toBe('image')
    expect(parseSkillDevelopmentWorkspaceTarget(currentRoute)).toEqual({
      panel: 'image',
      relativePath: 'baselines/img/log.png',
    })
  })

  it('图片面板与代码面板共用 ?path= 但不会互相误判', async () => {
    // 图片分支必须优先于 code 兜底分支，否则图片路径会被解析成代码文件
    const imageRouter = await navigateTo(
      '/skill-dev/skill-001/image?path=a.png',
    )
    expect(
      parseSkillDevelopmentWorkspaceTarget(imageRouter.currentRoute.value),
    ).toEqual({
      panel: 'image',
      relativePath: 'a.png',
    })

    const codeRouter = await navigateTo('/skill-dev/skill-001/code?path=a.png')
    expect(
      parseSkillDevelopmentWorkspaceTarget(codeRouter.currentRoute.value),
    ).toEqual({
      panel: 'code',
      relativePath: 'a.png',
    })
  })

  it('图片面板缺少路径时不予解析', async () => {
    const router = await navigateTo('/skill-dev/skill-001/image')

    expect(
      parseSkillDevelopmentWorkspaceTarget(router.currentRoute.value),
    ).toBeUndefined()
  })
})

describe('工作区定位函数的语义', () => {
  it('Chat 定位函数返回 chat 面板（与函数名一致）', async () => {
    // 回归保护：该函数曾返回 e2eTestCase，导致「回退到 Chat」实际落到
    // 依赖 e2e_schema.json 的结构化用例面板，文件缺失时用户被卡在报错面板上。
    const router = await navigateTo(
      createSkillDevelopmentChatLocation('skill-001'),
    )

    expect(router.currentRoute.value.name).toBe(
      SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
    )
    expect(router.currentRoute.value.meta.skillDevelopmentPanel).toBe('chat')
  })

  it('默认工作区定位函数返回 e2eTestCase 面板（进入 Skill 的落地页）', async () => {
    // 产品决策（commit 9d528b2）：从列表进入 Skill 时优先展示 E2E 用例工作区
    const router = await navigateTo(
      createSkillDevelopmentDefaultLocation('skill-001'),
    )

    expect(router.currentRoute.value.name).toBe(
      SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase,
    )
    expect(router.currentRoute.value.meta.skillDevelopmentPanel).toBe(
      'e2e-test-case',
    )
  })

  it('两个定位函数指向不同面板（不可互换）', async () => {
    const chatRouter = await navigateTo(
      createSkillDevelopmentChatLocation('skill-001'),
    )
    const defaultRouter = await navigateTo(
      createSkillDevelopmentDefaultLocation('skill-001'),
    )

    expect(chatRouter.currentRoute.value.name).not.toBe(
      defaultRouter.currentRoute.value.name,
    )
  })
})
