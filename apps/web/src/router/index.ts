// 应用路由入口：定义工作台独立页面、旧地址兼容重定向与 Skill 开发路由。
import {
  createRouter,
  createWebHistory,
  type LocationQueryRaw,
  type RouteLocationRaw,
  type RouteRecordRaw,
  type RouterHistory,
} from 'vue-router'
import WorkbenchPage from '../pages/WorkbenchPage.vue'
import {
  redirectSkillDevelopmentRoot,
  SKILL_DEVELOPMENT_ROUTE_NAMES,
} from './skill-development-navigation'
import { WORKBENCH_ROUTE_NAMES } from './workbench-navigation'

export const appRoutes: RouteRecordRaw[] = [
  {
    path: '/',
    name: WORKBENCH_ROUTE_NAMES.root,
    redirect: redirectLegacyWorkbenchRoute,
  },
  {
    path: '/',
    component: WorkbenchPage,
    children: [
      {
        path: 'agent',
        name: WORKBENCH_ROUTE_NAMES.agent,
        component: () => import('../pages/AgentWorkPage.vue'),
        meta: {
          workbenchNavigationKey: 'agent',
          workbenchPageTitle: 'Agent 工作台',
        },
      },
      {
        path: 'skills',
        name: WORKBENCH_ROUTE_NAMES.skills,
        component: () => import('../pages/SkillsPage.vue'),
        meta: {
          workbenchNavigationKey: 'skills',
          workbenchPageTitle: 'Skill 管理',
        },
      },
      {
        path: 'config',
        name: WORKBENCH_ROUTE_NAMES.config,
        component: () => import('../pages/ConfigurationPage.vue'),
        meta: {
          workbenchNavigationKey: 'config',
          workbenchPageTitle: '系统配置',
        },
      },
    ],
  },
  {
    path: '/skill-dev',
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.invalid,
    component: () => import('../pages/SkillDevPage.vue'),
  },
  {
    path: '/skill-dev/:skillId',
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.root,
    component: () => import('../pages/SkillDevPage.vue'),
    redirect: redirectSkillDevelopmentRoot,
    children: [
      {
        path: 'chat',
        name: SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
        component: () =>
          import('../modules/skill-development/routes/SkillDevelopmentChatRoute.vue'),
        meta: { skillDevelopmentPanel: 'chat' },
      },
      {
        path: 'code',
        name: SKILL_DEVELOPMENT_ROUTE_NAMES.code,
        component: () =>
          import('../modules/skill-development/routes/SkillDevelopmentCodeRoute.vue'),
        meta: { skillDevelopmentPanel: 'code' },
      },
      {
        path: 'e2e-test-case',
        name: SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase,
        component: () =>
          import('../modules/skill-development/routes/SkillDevelopmentE2ETestCaseRoute.vue'),
        meta: { skillDevelopmentPanel: 'e2e-test-case' },
      },
      {
        // v11 报告视图（PRD V3）：主内容区以网页形态渲染测试报告。
        path: 'report/:runId',
        name: SKILL_DEVELOPMENT_ROUTE_NAMES.report,
        component: () =>
          import('../modules/skill-development/routes/SkillDevelopmentReportRoute.vue'),
        meta: { skillDevelopmentPanel: 'report' },
      },
      {
        // v13 图片预览：文件树中的图片文件在此面板展示（文本编辑器无法打开二进制）。
        path: 'image',
        name: SKILL_DEVELOPMENT_ROUTE_NAMES.image,
        component: () =>
          import('../modules/skill-development/routes/SkillDevelopmentImageRoute.vue'),
        meta: { skillDevelopmentPanel: 'image' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: { name: WORKBENCH_ROUTE_NAMES.skills },
  },
]

/**
 * 创建使用指定历史实现的应用路由，便于生产环境与测试共享同一套路由定义。
 * @param history Vue Router 历史实现。
 * @returns 已配置完成的路由实例。
 * @throws 当路由配置无效时由 Vue Router 抛出异常。
 */
export function createAppRouter(history: RouterHistory = createWebHistory()) {
  return createRouter({ history, routes: appRoutes })
}

/**
 * 将旧版根路径查询参数转换为规范的工作台独立路由。
 * @param to 当前旧版根路径位置。
 * @returns 去除 `section` 后的 Skill 或配置命名路由位置。
 * @throws 不抛出异常。
 */
function redirectLegacyWorkbenchRoute(to: {
  query: Readonly<Record<string, string | null | (string | null)[]>>
  hash: string
}): RouteLocationRaw {
  const { section: _section, ...remainingQuery } = to.query
  const routeName =
    to.query.section === 'config'
      ? WORKBENCH_ROUTE_NAMES.config
      : WORKBENCH_ROUTE_NAMES.skills

  return {
    name: routeName,
    query: remainingQuery as LocationQueryRaw,
    hash: to.hash,
  }
}

export const router = createAppRouter()
