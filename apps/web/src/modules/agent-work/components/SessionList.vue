<!--
  会话列表（v17 S 组）：恢复对话的入口，展示标题、状态与最近活跃时间。

  v17 新增三件事：
    1. **顶部搜索框**（S3）：按标题在前端过滤（F22：不加端点）——列表本身是
       一次全量拉取的小集合，前端过滤即时且不产生请求；结果为空给明确空态；
    2. **行内重命名**（S1）：就地编辑（不弹框），Enter 提交 / Esc 取消。
       平台自动生成的标题可被覆盖；S4 保证改名不动任何任务状态；
    3. **行内删除**（S2）：**必须二次确认**——弹框里如实说明「只删对话记录，
       不影响用例、产物与报告」，有运行中任务时额外提示任务仍在服务端继续。
-->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NModal } from 'naive-ui'
import type { IAgentSessionSummary } from '@charlie_deng/e2e-assistant-types'
import IconFont from '../../../common/icon/IconFont.vue'
import { EMPTY_SESSION_ICON } from '../icons'

const props = defineProps<{
  /** 会话概要列表。 */
  sessions: IAgentSessionSummary[]
  /** 当前打开的会话 ID。 */
  activeSessionId: string | null
  /** 列表加载中。 */
  loading?: boolean
}>()

const emit = defineEmits<{
  /** 用户选中一个会话。 */
  select: [sessionId: string]
  /** 用户点击新建会话。 */
  create: []
  /** 用户确认重命名（v17 S1；标题已 trim）。 */
  rename: [sessionId: string, title: string]
  /** 用户确认删除（v17 S2；二次确认已通过）。 */
  remove: [sessionId: string]
}>()

/** 搜索关键词（S3：前端过滤标题）。 */
const keyword = ref('')

/** 正在就地编辑的会话 ID（为空表示无编辑）。 */
const editingId = ref<string>('')
/** 编辑中的标题草稿。 */
const editingTitle = ref('')

/** 待删除确认的会话（为空表示不展示弹框）。 */
const removeTarget = ref<IAgentSessionSummary | null>(null)

/** 过滤后的列表（S3）。 */
const filteredSessions = computed(() => {
  const text = keyword.value.trim().toLowerCase()
  if (!text) return props.sessions
  return props.sessions.filter((session) =>
    (session.title || '').toLowerCase().includes(text),
  )
})

/** 是否处于「有会话但被搜空」的状态（S3 要求明确空态）。 */
const searchedEmpty = computed(
  () => props.sessions.length > 0 && filteredSessions.value.length === 0,
)

/** 会话状态 → 展示文案与样式。 */
function statusMeta(status: IAgentSessionSummary['status']): {
  text: string
  className: string
} {
  const metas = {
    idle: { text: '空闲', className: 'idle' },
    running: { text: '运行中', className: 'running' },
    waiting_user: { text: '待确认', className: 'waiting' },
    error: { text: '出错', className: 'error' },
  } as const
  return metas[status] ?? metas.idle
}

/** 格式化最近活跃时间（当天显示时分，否则显示月日）。 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/**
 * 进入就地编辑（S1）。
 *
 * @param session - 目标会话。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function startRename(session: IAgentSessionSummary): void {
  editingId.value = session.sessionId
  editingTitle.value = session.title || ''
}

/** 退出编辑（不提交）。 */
function cancelRename(): void {
  editingId.value = ''
  editingTitle.value = ''
}

/**
 * 提交重命名（S1）：空标题与未变化时不发请求。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function submitRename(): void {
  const sessionId = editingId.value
  const title = editingTitle.value.trim()
  const original = props.sessions.find((item) => item.sessionId === sessionId)
  cancelRename()
  if (!sessionId || !title) return
  if (original && original.title === title) return
  emit('rename', sessionId, title)
}

/**
 * 在文本框中按键：Enter 提交、Esc 取消。
 * @param event - 键盘事件。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function onRenameKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault()
    submitRename()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    cancelRename()
  }
}

/**
 * 请求删除（S2）：先弹二次确认，不直接删。
 * @param session - 目标会话。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function requestRemove(session: IAgentSessionSummary): void {
  removeTarget.value = session
}

/**
 * 确认删除：向上抛出，由页面调接口。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function confirmRemove(): void {
  const target = removeTarget.value
  removeTarget.value = null
  if (!target) return
  emit('remove', target.sessionId)
}
</script>

<template>
  <div class="session-list">
    <div class="session-header">
      <span class="session-heading">会话</span>
      <button class="session-create" type="button" @click="emit('create')">
        <span aria-hidden="true" class="create-icon">＋</span>
        新会话
      </button>
    </div>

    <!-- S3：前端过滤（不加端点）；输入即过滤，无需按钮 -->
    <div class="session-search">
      <input
        v-model="keyword"
        class="search-input"
        type="search"
        placeholder="搜索会话标题"
        aria-label="搜索会话"
      />
    </div>

    <div class="session-body">
      <div v-if="loading" class="session-hint">加载中…</div>
      <div v-else-if="sessions.length === 0" class="session-hint">
        <IconFont class="hint-icon" :name="EMPTY_SESSION_ICON" :size="26" />
        <span>还没有会话</span>
      </div>
      <!-- S3：结果为空时给明确空态，而不是一片空白 -->
      <div v-else-if="searchedEmpty" class="session-hint">
        <span>没有匹配「{{ keyword.trim() }}」的会话</span>
      </div>

      <template v-else>
        <div
          v-for="session in filteredSessions"
          :key="session.sessionId"
          class="session-item"
          :class="{ active: session.sessionId === activeSessionId }"
        >
          <!-- 就地编辑（S1）：Enter 提交 / Esc 取消 / 失焦提交 -->
          <input
            v-if="editingId === session.sessionId"
            v-model="editingTitle"
            class="rename-input"
            type="text"
            aria-label="重命名会话"
            @keydown="onRenameKeydown"
            @blur="submitRename"
          />
          <button
            v-else
            class="session-main"
            type="button"
            @click="emit('select', session.sessionId)"
          >
            <span class="session-title">{{
              session.title || '未命名会话'
            }}</span>
            <span class="session-meta">
              <span
                class="session-status"
                :class="statusMeta(session.status).className"
              >
                {{ statusMeta(session.status).text }}
              </span>
              <span class="session-time">{{
                formatTime(session.updatedAt)
              }}</span>
            </span>
          </button>

          <!-- 行内操作：绝对定位浮在「状态 / 时间」行右侧，不占文本空间；
               默认隐藏，hover 或键盘聚焦整行时才显形 -->
          <div v-if="editingId !== session.sessionId" class="session-actions">
            <button
              class="action-button"
              type="button"
              title="重命名"
              aria-label="重命名会话"
              @click.stop="startRename(session)"
            >
              重命名
            </button>
            <button
              class="action-button danger"
              type="button"
              title="删除"
              aria-label="删除会话"
              @click.stop="requestRemove(session)"
            >
              删除
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- S2：删除必须二次确认；文案如实说明后果（有任务时额外提示） -->
    <n-modal
      :show="removeTarget !== null"
      :mask-closable="true"
      @update:show="(value) => !value && (removeTarget = null)"
    >
      <div
        v-if="removeTarget"
        class="remove-dialog"
        role="dialog"
        aria-modal="true"
      >
        <h3 class="dialog-title">确认删除会话？</h3>
        <p class="dialog-lead">
          将删除会话「{{ removeTarget.title || '未命名会话' }}」的对话记录。
        </p>
        <p class="dialog-note">
          只删对话记录，不影响任何用例、产物与报告；删除后不可恢复。
        </p>
        <p v-if="removeTarget.status === 'running'" class="dialog-warning">
          该会话当前有运行中的任务：删除后你将失去它的观察入口，任务本身仍在本地服务端继续运行。
        </p>
        <footer class="dialog-actions">
          <n-button size="small" @click="removeTarget = null">取消</n-button>
          <n-button type="error" size="small" @click="confirmRemove"
            >删除</n-button
          >
        </footer>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.session-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--color-border);
}
.session-heading {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-ink-body);
}
.session-create {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  border-radius: 8px;
  background: var(--color-action);
  color: #ffffff;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-out);
}
.session-create:hover {
  background: var(--color-action-hover);
}
.session-create:active {
  background: var(--color-action-active);
}
.create-icon {
  font-size: 14px;
  line-height: 1;
}
.session-search {
  flex-shrink: 0;
  padding: 8px 12px 4px;
}
.search-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  color: var(--color-ink-deep);
  font-size: 12.5px;
  outline: none;
}
.search-input:focus {
  border-color: var(--color-action);
}
.session-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
}
.session-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--color-ink-muted);
  font-size: 12.5px;
  text-align: center;
}
/* 颜色随 .session-hint 的中性墨色；字号走 size prop */
.hint-icon {
  flex-shrink: 0;
}
.session-item {
  /* 定位容器：行内操作绝对定位浮起，不参与布局，标题与时间占满整行宽度 */
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 8px;
  transition: background-color var(--motion-fast) var(--ease-out);
}
.session-item:hover {
  background: var(--color-well);
}
.session-item.active {
  background: #e8f5ee;
}
.session-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}
.session-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-ink-deep);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
}
.session-status.idle {
  color: #9ca3af;
}
.session-status.running {
  color: #2563eb;
}
.session-status.waiting {
  color: #d97706;
  font-weight: 600;
}
.session-status.error {
  color: #dc2626;
}
.session-time {
  color: #c4c9d1;
  transition: opacity var(--motion-fast) var(--ease-out);
}
/* 行内操作：绝对定位浮在「状态 / 时间」行右侧，**不参与布局**——
   标题与时间始终按整行宽度排布，按钮显形不会挤压它们 */
.session-actions {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  /* 隐藏时不拦截指针：点击该区域仍落到整行（选中会话），不会被隐形按钮吃掉 */
  pointer-events: none;
  transition: opacity var(--motion-fast) var(--ease-out);
}
.session-item:hover .session-actions,
.session-item:focus-within .session-actions {
  opacity: 1;
  pointer-events: auto;
}
/* 按钮显形时让位：时间淡出，由操作按钮占据其位置（二者不叠字） */
.session-item:hover .session-time,
.session-item:focus-within .session-time {
  opacity: 0;
}
.action-button {
  border: none;
  background: transparent;
  color: var(--color-ink-muted);
  font-size: 11.5px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
}
.action-button:hover {
  color: var(--color-ink-deep);
  background: var(--color-surface);
}
.action-button.danger:hover {
  color: #dc2626;
}
.rename-input {
  flex: 1;
  min-width: 0;
  margin: 6px 8px;
  padding: 6px 8px;
  border: 1px solid var(--color-action);
  border-radius: 6px;
  font-size: 13px;
  outline: none;
}
.remove-dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(460px, calc(100vw - 48px));
  padding: 18px 20px;
  border-radius: var(--radius-panel);
  background: var(--color-surface);
}
.dialog-title {
  margin: 0;
  color: var(--color-ink-deep);
  font-size: 15px;
  font-weight: 600;
}
.dialog-lead {
  margin: 0;
  color: var(--color-ink-body);
  font-size: 13px;
  line-height: 1.6;
}
.dialog-note {
  margin: 0;
  color: var(--color-ink-muted);
  font-size: 12.5px;
  line-height: 1.5;
}
.dialog-warning {
  margin: 0;
  color: #b45309;
  font-size: 12.5px;
  line-height: 1.5;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: 8px;
}
</style>
