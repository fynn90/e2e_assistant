// Skill 开发路由契约：集中定义工作区命名路由、面板元数据与文件路径解析。
import type {
  LocationQueryRaw,
  RouteLocationNormalizedLoaded,
  RouteLocationRaw,
  RouteRecordName,
} from 'vue-router'

export type TSkillDevelopmentPanel =
  'chat' | 'code' | 'e2e-test-case' | 'report' | 'image'

export type TSkillDevelopmentWorkspaceTarget =
  | { panel: 'chat' }
  | { panel: 'e2e-test-case' }
  | { panel: 'code'; relativePath: string }
  | { panel: 'report'; runId: string }
  | { panel: 'image'; relativePath: string }

export const SKILL_DEVELOPMENT_ROUTE_NAMES = {
  invalid: 'invalid-skill-development',
  root: 'skill-development',
  chat: 'skill-development-chat',
  code: 'skill-development-code',
  e2eTestCase: 'skill-development-e2e-test-case',
  report: 'skill-development-report',
  image: 'skill-development-image',
} as const satisfies Record<
  'invalid' | 'root' | 'chat' | 'code' | 'e2eTestCase' | 'report' | 'image',
  RouteRecordName
>

/**
 * 创建 Skill 开发 Chat 工作区的命名路由地址。
 *
 * **不要在「回退到安全面板」的场合使用本函数**——Chat 面板虽然不依赖任何 Skill 文件，
 * 但它是用户可以主动停留的独立工作区；文件缺失等异常回退应落到
 * {@link createSkillDevelopmentDefaultLocation}（默认工作区）。
 *
 * @param skillId 目标 Skill ID。
 * @returns Chat 子路由地址。
 * @throws 不抛出异常。
 */
export function createSkillDevelopmentChatLocation(
  skillId: string,
): RouteLocationRaw {
  return {
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
    params: { skillId },
  }
}

/**
 * 创建 Skill 开发默认工作区的命名路由地址（即结构化 E2E 用例工作区）。
 *
 * 产品决策（commit 9d528b2）：用户从 Skill 列表进入时**优先看到 E2E 用例工作区**，
 * 而不是 Chat。因此「进入 Skill 的落地页」与「当前工作区失效后的回退页」都用本函数。
 *
 * **回退场景的限制**：默认工作区依赖 `e2e_schema.json`。若回退的起因正是该文件缺失，
 * 必须改用 `createSkillDevelopmentChatLocation`（Chat 不依赖任何文件），
 * 否则会落在必然报错的空面板上。
 *
 * @param skillId 目标 Skill ID。
 * @returns 默认工作区（结构化 E2E 用例）子路由地址。
 * @throws 不抛出异常。
 */
export function createSkillDevelopmentDefaultLocation(
  skillId: string,
): RouteLocationRaw {
  return {
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase,
    params: { skillId },
  }
}

/**
 * 创建 Skill 开发结构化 E2E 工作区的命名路由地址。
 * @param skillId 目标 Skill ID。
 * @returns 结构化 E2E 子路由地址。
 * @throws 不抛出异常。
 */
export function createSkillDevelopmentE2ETestCaseLocation(
  skillId: string,
): RouteLocationRaw {
  return {
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase,
    params: { skillId },
  }
}

/**
 * 创建 Skill 开发代码工作区的命名路由地址。
 * @param skillId 目标 Skill ID。
 * @param relativePath 待打开文件的 Skill 相对路径。
 * @returns 携带原始相对路径 query 的代码子路由地址。
 * @throws 不抛出异常，路径编码由 Vue Router 统一处理。
 */
export function createSkillDevelopmentCodeLocation(
  skillId: string,
  relativePath: string,
): RouteLocationRaw {
  return {
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.code,
    params: { skillId },
    query: { path: relativePath },
  }
}

/**
 * 创建 Skill 开发图片预览工作区的命名路由地址（v13）。
 * @param skillId 目标 Skill ID。
 * @param relativePath 待预览图片的 Skill 相对路径。
 * @returns 携带原始相对路径 query 的图片预览子路由地址。
 * @throws 不抛出异常，路径编码由 Vue Router 统一处理。
 */
export function createSkillDevelopmentImageLocation(
  skillId: string,
  relativePath: string,
): RouteLocationRaw {
  return {
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.image,
    params: { skillId },
    query: { path: relativePath },
  }
}

/**
 * 创建 Skill 开发报告视图工作区的命名路由地址（v11，PRD V3）。
 * @param skillId 目标 Skill ID。
 * @param runId 报告运行时间戳（yyyyMMdd-HHmmss）。
 * @returns 报告视图子路由地址。
 * @throws 不抛出异常。
 */
export function createSkillDevelopmentReportLocation(
  skillId: string,
  runId: string,
): RouteLocationRaw {
  return {
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.report,
    params: { skillId, runId },
  }
}

/**
 * 将当前子路由解析为 Skill 开发工作区目标。
 * @param route 当前已规范化路由。
 * @returns 有效工作区目标；代码路径缺失、为空或为数组时返回 undefined。
 * @throws 不抛出异常。
 */
export function parseSkillDevelopmentWorkspaceTarget(
  route: Pick<RouteLocationNormalizedLoaded, 'name' | 'params' | 'query'>,
): TSkillDevelopmentWorkspaceTarget | undefined {
  if (route.name === SKILL_DEVELOPMENT_ROUTE_NAMES.chat) {
    return { panel: 'chat' }
  }

  if (route.name === SKILL_DEVELOPMENT_ROUTE_NAMES.e2eTestCase) {
    return { panel: 'e2e-test-case' }
  }

  if (route.name === SKILL_DEVELOPMENT_ROUTE_NAMES.report) {
    const runId = (route.params as Record<string, unknown>).runId
    return typeof runId === 'string' && /^\d{8}-\d{6}$/.test(runId)
      ? { panel: 'report', runId }
      : undefined
  }

  // 图片预览与代码面板同用 `?path=` 寻址，因此必须插在下面的 code 兜底分支之前，
  // 否则图片路径会被当作代码文件解析。
  if (route.name === SKILL_DEVELOPMENT_ROUTE_NAMES.image) {
    const relativePath = route.query.path
    return typeof relativePath === 'string' && relativePath.length > 0
      ? { panel: 'image', relativePath }
      : undefined
  }

  if (route.name !== SKILL_DEVELOPMENT_ROUTE_NAMES.code) {
    return undefined
  }

  const relativePath = route.query.path
  return typeof relativePath === 'string' && relativePath.length > 0
    ? { panel: 'code', relativePath }
    : undefined
}

/**
 * 将旧 Skill 开发根地址规范化为 Chat 子路由，同时保留 query 与 hash。
 *
 * **注意**：规范化目标是 Chat，而正常入口（从 Skill 列表进入）落在默认工作区
 * （结构化 E2E 用例，见 {@link createSkillDevelopmentDefaultLocation}）。
 * 二者不一致意味着「用旧地址打开」与「从列表点击打开」会落在不同面板。
 * 这是既有行为（有测试与 e2e 用例分别锁定两侧），本次修复**未改动**它——
 * 是否统一属于独立的产品决策，需要时再单独评估。
 *
 * @param to 当前父路由位置。
 * @returns Chat 子路由重定向地址。
 * @throws 不抛出异常。
 */
export function redirectSkillDevelopmentRoot(to: {
  params: Readonly<Record<string, string | string[]>>
  query: Readonly<Record<string, string | null | (string | null)[]>>
  hash: string
}): RouteLocationRaw {
  return {
    name: SKILL_DEVELOPMENT_ROUTE_NAMES.chat,
    params: { skillId: to.params.skillId },
    query: to.query as LocationQueryRaw,
    hash: to.hash,
  }
}

declare module 'vue-router' {
  interface RouteMeta {
    skillDevelopmentPanel?: TSkillDevelopmentPanel
  }
}
