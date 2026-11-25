<!-- 工作台路由布局：组合响应式应用外壳、路由驱动导航与独立子页面。 -->
<script setup lang="ts">
import { computed } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import WorkbenchShell from '../components/workbench/WorkbenchShell.vue'
import {
  WORKBENCH_ROUTE_BY_NAVIGATION_KEY,
  type TWorkbenchNavigationKey,
} from '../router/workbench-navigation'

const route = useRoute()
const router = useRouter()

const activeNavigationKey = computed<TWorkbenchNavigationKey>(
  () => route.meta.workbenchNavigationKey ?? 'skills',
)
const pageTitle = computed(() => route.meta.workbenchPageTitle ?? 'Skill 管理')

/**
 * 导航到工作台中与侧栏选项对应的独立页面。
 * @param key 目标工作台导航键。
 * @returns 导航触发后无返回值。
 * @throws 不抛出异常，路由失败由 Vue Router 处理。
 */
function navigate(key: TWorkbenchNavigationKey): void {
  if (key === activeNavigationKey.value) {
    return
  }

  void router.push({ name: WORKBENCH_ROUTE_BY_NAVIGATION_KEY[key] })
}
</script>

<template>
  <workbench-shell
    :active-navigation-key="activeNavigationKey"
    :page-title="pageTitle"
    @navigate="navigate"
  >
    <router-view />
  </workbench-shell>
</template>
