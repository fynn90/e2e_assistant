<!-- 工作台响应式外壳：承载桌面侧栏、移动抽屉、页头与内容滚动区域。 -->
<script setup lang="ts">
import { h, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  NDrawer,
  NDrawerContent,
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutHeader,
  NLayoutSider,
  NMenu,
} from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import type { TWorkbenchNavigationKey } from '../../router/workbench-navigation'

const props = defineProps<{
  activeNavigationKey: TWorkbenchNavigationKey
  pageTitle: string
}>()

const emit = defineEmits<{
  navigate: [key: TWorkbenchNavigationKey]
}>()

const mobileMedia = window.matchMedia('(max-width: 760px)')
const desktopCollapsed = ref(false)
const mobileDrawerVisible = ref(false)
const isMobile = ref(mobileMedia.matches)
const mobileMenuTriggerRef = ref<HTMLButtonElement | null>(null)
let shouldRestoreDrawerFocus = false

const menuOptions: MenuOption[] = [
  {
    label: 'Agent',
    key: 'agent',
    icon: renderIcon(
      'M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4zm-2 5v1h4V7a2 2 0 1 0-4 0zm-1 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
    ),
  },
  {
    label: 'Skill',
    key: 'skills',
    icon: renderIcon(
      'M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z',
    ),
  },
  {
    label: '配置',
    key: 'config',
    icon: renderIcon(
      'M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2zm8.8 4.54-.02-.94.02-.94 2.03-1.58-1.92-3.32-2.39.96a8.2 8.2 0 0 0-1.62-.94L16.54 3h-3.84l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96-1.92 3.32 2.03 1.58-.06.94.06.94-2.03 1.58 1.92 3.32 2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54h3.84l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96 1.92-3.32-2.03-1.58z',
    ),
  },
]

onMounted(() => mobileMedia.addEventListener('change', syncMobileMode))
onBeforeUnmount(() => mobileMedia.removeEventListener('change', syncMobileMode))

/**
 * 创建与 Naive Menu 兼容的 SVG 图标渲染函数。
 * @param pathData SVG path 的路径数据。
 * @returns 可由菜单调用的图标渲染函数。
 * @throws 不抛出异常。
 */
function renderIcon(pathData: string) {
  return () =>
    h(NIcon, null, {
      default: () =>
        h(
          'svg',
          { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24' },
          [h('path', { d: pathData, fill: 'currentColor' })],
        ),
    })
}

/**
 * 响应断点变化，并在返回桌面布局时关闭移动抽屉。
 * @param event 当前媒体查询状态。
 * @returns 同步完成后无返回值。
 * @throws 不抛出异常。
 */
function syncMobileMode(event: MediaQueryListEvent): void {
  isMobile.value = event.matches

  if (!event.matches) {
    shouldRestoreDrawerFocus = false
    mobileDrawerVisible.value = false
  }
}

/**
 * 打开移动导航抽屉。
 * @returns 打开完成后无返回值。
 * @throws 不抛出异常。
 */
function openMobileNavigation(): void {
  shouldRestoreDrawerFocus = false
  mobileDrawerVisible.value = true
}

/**
 * 接收抽屉遮罩、关闭按钮或 Escape 触发的可见性变化。
 * @param visible 抽屉目标可见状态。
 * @returns 更新完成后无返回值。
 * @throws 不抛出异常。
 */
function updateMobileDrawerVisibility(visible: boolean): void {
  if (!visible && mobileDrawerVisible.value) {
    shouldRestoreDrawerFocus = true
  }

  mobileDrawerVisible.value = visible
}

/**
 * 在抽屉离场后将键盘焦点归还给菜单触发按钮。
 * @returns 焦点恢复完成后无返回值。
 * @throws 不抛出异常。
 */
async function restoreMobileMenuFocus(): Promise<void> {
  if (!shouldRestoreDrawerFocus || !isMobile.value) {
    return
  }

  shouldRestoreDrawerFocus = false
  await nextTick()
  mobileMenuTriggerRef.value?.focus()
}

/**
 * 处理导航选择，并在移动端关闭抽屉。
 * @param key 目标工作台导航键。
 * @returns 导航事件发送完成后无返回值。
 * @throws 不抛出异常。
 */
function handleNavigate(key: string): void {
  const targetKey = key as TWorkbenchNavigationKey

  if (isMobile.value) {
    shouldRestoreDrawerFocus = true
    mobileDrawerVisible.value = false
  }

  emit('navigate', targetKey)
}
</script>

<template>
  <n-layout has-sider class="workbench-shell">
    <n-layout-sider
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="240"
      :collapsed="desktopCollapsed"
      show-trigger
      class="workbench-sider workbench-sider--desktop"
      @collapse="desktopCollapsed = true"
      @expand="desktopCollapsed = false"
    >
      <div class="brand-section">
        <div
          class="brand-logo"
          :class="{ 'brand-logo--collapsed': desktopCollapsed }"
        >
          <span class="brand-tag">A2e</span>
          <span v-if="!desktopCollapsed" class="brand-title">e2e_assistant</span>
        </div>
      </div>
      <n-menu
        :collapsed="desktopCollapsed"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="menuOptions"
        :value="props.activeNavigationKey"
        @update:value="handleNavigate"
      />
    </n-layout-sider>

    <n-layout class="workbench-main" :native-scrollbar="false">
      <n-layout-header bordered class="workbench-header">
        <button
          ref="mobileMenuTriggerRef"
          type="button"
          class="mobile-menu-trigger"
          aria-label="打开工作台导航"
          :aria-expanded="mobileDrawerVisible"
          @click="openMobileNavigation"
        >
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
          <span aria-hidden="true"></span>
        </button>
        <h1 class="header-title">{{ props.pageTitle }}</h1>
      </n-layout-header>

      <n-layout-content class="workbench-content">
        <div class="content-wrapper">
          <slot />
        </div>
      </n-layout-content>
    </n-layout>
  </n-layout>

  <n-drawer
    :show="mobileDrawerVisible"
    :width="220"
    placement="left"
    :auto-focus="true"
    :trap-focus="true"
    :mask-closable="true"
    @update:show="updateMobileDrawerVisibility"
    @after-leave="restoreMobileMenuFocus"
  >
    <n-drawer-content
      title="工作台导航"
      closable
      body-content-style="padding: 0 12px 16px;"
    >
      <div class="drawer-brand" aria-label="e2e_assistant">
        <span class="brand-tag">A2e</span>
        <span class="brand-title">e2e_assistant</span>
      </div>
      <n-menu
        :options="menuOptions"
        :value="props.activeNavigationKey"
        @update:value="handleNavigate"
      />
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.workbench-shell {
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--color-canvas);
}

.workbench-sider {
  background: var(--color-surface);
  box-shadow: var(--shadow-sidebar);
  z-index: var(--z-sticky);
}

.brand-section {
  display: flex;
  align-items: center;
  height: 64px;
  padding: 0 var(--space-lg);
  overflow: hidden;
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.brand-logo,
.drawer-brand {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}

.brand-logo--collapsed {
  justify-content: center;
  width: 100%;
}

.brand-tag {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-brand);
  background: rgb(59 130 246 / 10%);
  color: var(--color-review);
  font-size: 14px;
  font-weight: 700;
}

.brand-title {
  color: var(--color-ink-deep);
  font-size: 18px;
  font-weight: 600;
}

.workbench-main {
  min-width: 0;
  background: var(--color-canvas);
}

.workbench-header {
  position: sticky;
  top: 0;
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  gap: var(--space-md);
  height: 64px;
  padding: 0 var(--space-page);
  background: var(--color-surface);
  box-shadow: var(--shadow-header);
}

.header-title {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  text-wrap: balance;
}

.mobile-menu-trigger {
  display: none;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 4px;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
  color: var(--color-ink-body);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.mobile-menu-trigger:hover {
  border-color: var(--color-review);
  background: var(--color-well);
}

.mobile-menu-trigger:focus-visible {
  outline: none;
  border-color: var(--color-review);
  box-shadow: var(--focus-ring);
}

.mobile-menu-trigger span {
  width: 18px;
  height: 2px;
  border-radius: 1px;
  background: currentcolor;
}

.workbench-content {
  /* 始终撑满视口剩余高度：文档型页面灰底铺满全屏，工作区页面在此基础上自撑 */
  min-height: calc(100vh - 64px);
  min-height: calc(100dvh - 64px);
  padding: 0;
  background: var(--color-well);
  display: flex;
  flex-direction: column;
}

/* 内容包装层：宽屏整页工作区（如 Agent 工作台）可直接撑满，文档型页面由此居中承载 */
.content-wrapper {
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
  margin: 0 auto;
}

.drawer-brand {
  padding: var(--space-sm) var(--space-sm) var(--space-lg);
  border-bottom: 1px solid var(--color-border);
  margin-bottom: var(--space-sm);
}

:deep(.n-menu-item-content--selected) {
  font-weight: 600;
}

@media (max-width: 760px) {
  .workbench-sider--desktop {
    display: none;
  }

  .mobile-menu-trigger {
    display: inline-flex;
  }

  .workbench-header {
    padding: 0 var(--space-md);
  }

  .workbench-content {
    padding: 0;
  }
}
</style>
