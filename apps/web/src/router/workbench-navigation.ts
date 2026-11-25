// 工作台路由契约：集中定义导航键、命名路由与页面元数据类型。
import type { RouteRecordName } from 'vue-router'

export type TWorkbenchNavigationKey = 'agent' | 'skills' | 'config'

export const WORKBENCH_ROUTE_NAMES = {
  root: 'workbench',
  agent: 'workbench-agent',
  skills: 'workbench-skills',
  config: 'workbench-config',
} as const satisfies Record<'root' | TWorkbenchNavigationKey, RouteRecordName>

export const WORKBENCH_ROUTE_BY_NAVIGATION_KEY: Record<
  TWorkbenchNavigationKey,
  RouteRecordName
> = {
  agent: WORKBENCH_ROUTE_NAMES.agent,
  skills: WORKBENCH_ROUTE_NAMES.skills,
  config: WORKBENCH_ROUTE_NAMES.config,
}

declare module 'vue-router' {
  interface RouteMeta {
    workbenchNavigationKey?: TWorkbenchNavigationKey
    workbenchPageTitle?: string
  }
}
