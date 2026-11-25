<!-- Skill 文件树：展示文件节点、处理选中打开与刷新；标题由页面顶栏统一展示。
     v14：userWorkSpace 根目录受保护（无删除按钮），其内目录/文件提供悬停
     新建与删除操作（全部带 Tooltip，直接进入名称输入）。 -->
<script setup lang="ts">
import { computed, h, ref } from 'vue'
import {
  NButton,
  NCard,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NTooltip,
  NTree,
  useMessage,
} from 'naive-ui'
import {
  isProtectedSkillRootEntry,
  normalizeUserWorkspaceRelativePath,
  USER_WORKSPACE_DIRECTORY_NAME,
  type ISkillFileTreeNode,
} from '@fynn90-e2e_assistant/types'
import type { TreeOption } from 'naive-ui'
import IconFont from '../../common/icon/IconFont.vue'
import {
  createUserWorkspaceDirectory,
  createUserWorkspaceFile,
} from '../../services/skill-api'
import type { ISkillTreeOption } from './skill-file'
import { toTreeOptions } from './skill-file'

const props = defineProps<{
  nodes: ISkillFileTreeNode[]
  /** 当前 Skill ID（v14：userWorkSpace 新建入口调用创建 API 时使用）。 */
  skillId?: string
  selectedPath?: string
  refreshing?: boolean
  /** 「执行测试用例」按钮是否显示（根目录存在 test.spec.ts 且非只读，PRD E1/E3；隐藏而非置灰，E2）。 */
  executionVisible?: boolean
  /** 执行进行中（按钮加载态、不可重复点击，PRD 4.1.3；删除确认的风险提示，v14 场景 15）。 */
  executionRunning?: boolean
  /** 是否显示报告运行目录的删除按钮（只读 Skill 不显示）。 */
  reportDeleteEnabled?: boolean
  /**
   * 是否允许删除/新建等管理操作（v14 由 deleteEnabled 更名，覆盖删除与新建两类，
   * 只读 Skill 不显示删除与新建按钮）。
   */
  actionsEnabled?: boolean
}>()
const emit = defineEmits<{
  open: [node: ISkillFileTreeNode]
  refresh: []
  /**
   * userWorkSpace 内新建了目录或文件（v14 W48）。
   *
   * 与 `refresh`（手动刷新按钮，走带节流的 refreshTreeManually）区分：
   * 创建成功后必须**立即**反映新节点，不能被 3 秒节流吞掉，因此单列一个事件，
   * 由页面接到非节流的 refreshTree（与删除流程同源）。
   */
  created: []
  /** 发起执行测试用例（v11）。 */
  execute: []
  /** 删除指定运行时间戳的测试报告（v11）。 */
  deleteReport: [runId: string]
  /** 删除指定文件或目录（v13）。 */
  deleteEntry: [relativePath: string]
}>()
const expandedKeys = defineModel<string[]>('expandedKeys', {
  default: () => [],
})

const message = useMessage()

/** 待删除的报告运行目录（非空时显示删除确认弹窗）。 */
const pendingDeleteRunId = ref<string | null>(null)

/**
 * 待删除的文件或目录（v13）。
 *
 * 记录节点而非仅路径：确认弹窗需要按类型区分文案（删目录要提示「连同其下全部内容」，
 * 且能事先算出影响面），仅凭路径字符串无法可靠判断节点类型。
 */
const pendingDeleteNode = ref<ISkillFileTreeNode | null>(null)

/** 待新建的目标（v14 W45：直接进入名称输入，不先选类型）。 */
interface IPendingCreate {
  /** 新建内容落在哪个目录（Skill 内相对路径，如 userWorkSpace 或 userWorkSpace/exports）。 */
  parentRelativePath: string
  /** 新建种类。 */
  kind: 'directory' | 'file'
}

const pendingCreate = ref<IPendingCreate | null>(null)
/** 新建名称输入（失败时保留，W48）。 */
const createName = ref('')
/** 新建校验/提交错误（展示在弹窗内，保留输入）。 */
const createError = ref('')
/** 新建提交进行中。 */
const creating = ref(false)

/** 判断目录节点是否为报告运行目录（test_report/<yyyyMMdd-HHmmss>）。 */
function isReportRunDirectory(option: ISkillTreeOption): boolean {
  const node = option.node
  return (
    node.kind === 'directory' &&
    node.relativePath.startsWith('test_report/') &&
    /^\d{8}-\d{6}$/.test(node.relativePath.split('/')[1] ?? '')
  )
}

/**
 * 判断节点是否为受保护的 userWorkSpace 根（v14 W12：不可删除/重命名）。
 *
 * 判定只看 `protection` 标记、不看 kind：正常场景是目录节点；当 userWorkSpace
 * 路径被同名普通文件占用（W10 边缘场景）时服务端标注的是文件节点，同样受保护，
 * 因此不能以 kind 收窄（否则该节点会漏掉锁定图标与删除按钮隐藏）。
 *
 * @param node 文件树节点。
 * @returns 是受保护根节点时返回 true。
 * @throws 不抛出异常。
 */
function isUserWorkspaceRoot(node: ISkillFileTreeNode): boolean {
  return node.protection === 'user-workspace-root'
}

/**
 * 判断节点是否位于 userWorkSpace 内（含根目录自身）。
 *
 * @param node 文件树节点。
 * @returns 位于 userWorkSpace 内时返回 true。
 * @throws 不抛出异常。
 */
function isInsideUserWorkspace(node: ISkillFileTreeNode): boolean {
  return (
    isUserWorkspaceRoot(node) ||
    node.relativePath
      .toLowerCase()
      .startsWith(`${USER_WORKSPACE_DIRECTORY_NAME.toLowerCase()}/`)
  )
}

/**
 * 判断节点是否允许删除（v13 + v14 扩展保护面）。
 *
 * 拦截「创建 Skill 时生成的文件」与 userWorkSpace 根目录（与需求一致）；
 * 其余（基线、报告、脚本、文档、用户自建目录、userWorkSpace 子内容）均可删。
 * **根目录下的这些文件**由前端隐藏按钮以获得即时反馈，服务端仍有同样的保护作为最终防线。
 *
 * @param node 文件树节点。
 * @returns 可删除时返回 true。
 * @throws 不抛出异常。
 */
function isDeletableNode(node: ISkillFileTreeNode): boolean {
  // 保护清单来自 types 包，与服务端共用同一份，避免两侧漂移。
  if (isProtectedSkillRootEntry(node.relativePath)) return false
  // userWorkSpace 根目录：前端不渲染删除按钮（W21；服务端 file-delete 是最终防线）。
  if (isUserWorkspaceRoot(node)) return false
  return true
}

/**
 * 为节点装饰悬停操作按钮（v14 W40-W44/D6：按节点类型细化，全部带 Tooltip）。
 *
 * 三类 userWorkSpace 节点（W41-W43）：
 *   - 根目录：「新建目录」「新建文件」（无删除，W21）；
 *   - 子目录：「新建目录」「新建文件」「删除」；
 *   - 文件：「删除」。
 * userWorkSpace 之外的节点沿用既有规则（报告运行目录删除 / v13 通用删除），
 * 不出现新建按钮（W44）。按钮默认隐藏，hover 所在行时显示（见非 scoped 样式块）。
 *
 * @param options 当前层级树选项。
 * @returns 装饰后的树选项。
 * @throws 不抛出异常。
 */
function decorateNodeActions(options: ISkillTreeOption[]): ISkillTreeOption[] {
  return options.map((option) => {
    const next: ISkillTreeOption = { ...option }
    const node = next.node

    if (isInsideUserWorkspace(node)) {
      next.suffix = () => renderWorkspaceActions(node)
    } else if (props.reportDeleteEnabled && isReportRunDirectory(next)) {
      const runId = next.node.relativePath.split('/')[1] ?? ''
      next.suffix = () =>
        renderTooltipButton('删除这份测试报告', 'delete-o', () => {
          pendingDeleteRunId.value = runId
        })
    } else if (
      props.actionsEnabled &&
      !isReportRunDirectory(next) &&
      isDeletableNode(next.node)
    ) {
      // 非报告节点：文件与目录都可删（目录递归删除）。
      // 报告目录已由上面的分支处理，此处排除以免出现两个删除按钮。
      next.suffix = () =>
        renderTooltipButton(
          node.kind === 'directory' ? '删除该目录及其内容' : '删除该文件',
          'delete-o',
          () => {
            pendingDeleteNode.value = node
          },
        )
    }

    if (next.children) {
      next.children = decorateNodeActions(next.children as ISkillTreeOption[])
    }
    return next
  })
}

/**
 * 渲染 userWorkSpace 节点的悬停操作（v14 W40-W44 / D6）。
 *
 * 结构分两层，可见性不同：
 *   - **常驻锁定图标**：受保护根目录（W21）始终显示锁标识（不随 hover 隐藏），
 *     让用户一眼看出「不可删除」；有降级 notice 时锁图标带 Tooltip 说明原因（W20）；
 *   - **悬停操作按钮**（`.tree-node-actions`，hover 才显现）：新建目录 / 新建文件 /
 *     删除，按节点类型细化，全部带 Tooltip（W40-W43）。
 *
 * @param node 目标节点。
 * @returns 单个包裹 VNode（常驻锁 + 悬停按钮组）。
 * @throws 不抛出异常。
 */
function renderWorkspaceActions(node: ISkillFileTreeNode) {
  const actionButtons: ReturnType<typeof h>[] = []

  if (node.kind === 'directory') {
    if (props.actionsEnabled && props.skillId) {
      // W46：目录节点上新建的子内容创建在该目录之下；根节点上是 userWorkSpace 第一层。
      const locationText = isUserWorkspaceRoot(node)
        ? '在 userWorkSpace 下'
        : `在 ${node.relativePath} 下`
      actionButtons.push(
        renderTooltipButton(`${locationText}新建目录`, 'folder-o', () => {
          openCreateModal(node, 'directory')
        }),
        renderTooltipButton(`${locationText}新建文件`, 'file-o', () => {
          openCreateModal(node, 'file')
        }),
      )
    }
  }

  // 删除按钮：根目录不渲染（W21），子内容在允许管理时渲染（W42/W43）。
  if (
    !isUserWorkspaceRoot(node) &&
    props.actionsEnabled &&
    isDeletableNode(node)
  ) {
    actionButtons.push(
      renderTooltipButton(
        node.kind === 'directory' ? '删除该目录及其内容' : '删除该文件',
        'delete-o',
        () => {
          pendingDeleteNode.value = node
        },
      ),
    )
  }

  // 常驻锁标识：受保护根节点始终显示（W21）；有 notice（补建降级）时附 Tooltip（W20）。
  // notice 不按 kind 收窄：被同名文件占用的文件节点同样携带补建失败原因。
  const notice = node.notice
  const lockNodes: ReturnType<typeof h>[] = []
  if (isUserWorkspaceRoot(node)) {
    const lockIcon = h(IconFont, {
      name: 'lock-o',
      size: 13,
      class: 'tree-lock-icon',
    })
    lockNodes.push(
      notice
        ? h(
            NTooltip,
            { trigger: 'hover', placement: 'top' },
            {
              trigger: () => lockIcon,
              default: () => notice,
            },
          )
        : lockIcon,
    )
  }

  return h('span', { class: 'tree-node-suffix' }, [
    ...lockNodes,
    // 悬停按钮组：始终渲染容器（空时无占位），按钮本身随 hover 显现。
    h('span', { class: 'tree-node-actions' }, actionButtons),
  ])
}

/**
 * 渲染单个带 Tooltip 的图标按钮。
 *
 * @param tooltip 提示文案（W40：说明点击后的行为）。
 * @param icon 图标名。
 * @param onClick 点击回调。
 * @returns VNode。
 * @throws 不抛出异常。
 */
function renderTooltipButton(
  tooltip: string,
  icon: string,
  onClick: () => void,
): ReturnType<typeof h> {
  return h(
    NTooltip,
    { trigger: 'hover', placement: 'top' },
    {
      trigger: () =>
        h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            class: 'tree-action-button',
            onClick: (event: MouseEvent) => {
              event.stopPropagation()
              onClick()
            },
          },
          { icon: () => h(IconFont, { name: icon, size: 14 }) },
        ),
      default: () => tooltip,
    },
  )
}

const options = computed(() => decorateNodeActions(toTreeOptions(props.nodes)))

/**
 * 打开新建弹窗（W45：直接进入名称输入）。
 *
 * @param node 所悬停的目录节点（新建内容落在其下，W46）。
 * @param kind 新建种类。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function openCreateModal(
  node: ISkillFileTreeNode,
  kind: 'directory' | 'file',
): void {
  pendingCreate.value = { parentRelativePath: node.relativePath, kind }
  createName.value = ''
  createError.value = ''
}

/** 关闭新建弹窗。 */
function closeCreateModal(): void {
  pendingCreate.value = null
}

/**
 * 校验新建名称（W47：与所在目录路径拼接后过 userWorkSpace 相对路径校验；
 * 非法名称即时提示且不提交）。
 *
 * @returns 错误文案；校验通过时返回 undefined。
 * @throws 不抛出异常。
 */
function validateCreateName(): string | undefined {
  const target = pendingCreate.value
  if (!target) return '新建目标缺失。'

  const name = createName.value.trim()
  if (!name) return '请输入名称。'

  // 拼接「所在目录 + 输入名称」后按 userWorkSpace 内相对路径统一校验（W47）。
  const inner = target.parentRelativePath
    .toLowerCase()
    .startsWith(USER_WORKSPACE_DIRECTORY_NAME.toLowerCase())
    ? `${target.parentRelativePath}/${name}`
    : `${USER_WORKSPACE_DIRECTORY_NAME}/${target.parentRelativePath}/${name}`
  if (normalizeUserWorkspaceRelativePath(inner) === undefined) {
    return '名称不合法：只允许字母、数字、下划线、中划线等安全字符，不能包含 .. 或绝对路径。'
  }

  return undefined
}

/**
 * 确认新建：调用创建 API，成功后刷新文件树并展开父目录（W48）；
 * 失败保留输入并展示原因。
 *
 * @returns 提交完成后兑现的 Promise。
 * @throws 不主动抛出异常——失败以弹窗内错误文案呈现。
 */
async function confirmCreate(): Promise<void> {
  const target = pendingCreate.value
  if (!target || !props.skillId) return

  const validationError = validateCreateName()
  if (validationError) {
    createError.value = validationError
    return
  }

  // 拼接 userWorkSpace 内相对路径（服务端按 D2 规则再校验一次）。
  // 父目录是 userWorkSpace 根时内层路径为空（归一化会剥离前导段）。
  const parentInner =
    target.parentRelativePath.toLowerCase() ===
    USER_WORKSPACE_DIRECTORY_NAME.toLowerCase()
      ? ''
      : (normalizeUserWorkspaceRelativePath(target.parentRelativePath) ?? '')
  const name = createName.value.trim()
  const relativePath = parentInner ? `${parentInner}/${name}` : name

  creating.value = true
  try {
    if (target.kind === 'directory') {
      await createUserWorkspaceDirectory(props.skillId, relativePath)
    } else {
      // R10：新建文件创建为空文件，查看与修改沿用现有打开/保存规则。
      await createUserWorkspaceFile(props.skillId, relativePath, '')
    }

    const createdLabel = target.kind === 'directory' ? '目录' : '文件'
    message.success(
      `已新建${createdLabel}：${USER_WORKSPACE_DIRECTORY_NAME}/${relativePath}`,
    )
    // W48：成功后刷新并展开父目录展示新节点。
    // 用 `created` 而非 `refresh`：后者走带 3 秒节流的 refreshTreeManually，
    // 连续创建（先目录后文件）时第二次刷新会被节流吞掉，新节点不显示。
    pendingCreate.value = null
    if (!expandedKeys.value.includes(target.parentRelativePath)) {
      expandedKeys.value = [...expandedKeys.value, target.parentRelativePath]
    }
    emit('created')
  } catch (error) {
    // W48：失败保留输入并展示原因。
    createError.value =
      error instanceof Error ? error.message : '新建失败，请重试。'
  } finally {
    creating.value = false
  }
}

/** 关闭删除确认弹窗。 */
function closeDeleteModal(): void {
  pendingDeleteRunId.value = null
  pendingDeleteNode.value = null
}

/** 确认删除：向页面发删除事件并关闭弹窗。 */
function confirmDelete(): void {
  const runId = pendingDeleteRunId.value
  const node = pendingDeleteNode.value
  closeDeleteModal()

  if (runId) {
    emit('deleteReport', runId)
    return
  }

  if (node) {
    emit('deleteEntry', node.relativePath)
  }
}

/**
 * 将树组件的选择结果转换为文件打开事件。
 * @param keys 当前选中的树节点键。
 * @param selectedOptions 当前选中的树节点选项。
 * @returns 无返回值。
 * @throws 不抛出异常。
 */
function handleSelect(
  keys: Array<string | number>,
  selectedOptions: Array<TreeOption | null>,
): void {
  void keys
  const option = selectedOptions[0] as ISkillTreeOption | null
  if (option?.node.kind === 'file') emit('open', option.node)
}
</script>

<template>
  <aside class="explorer" aria-label="Skill 文件树">
    <div class="explorer-header">
      <!-- 执行入口（v11）：居左、info 色次级形态（与页面大量 primary 绿色按钮区分）；
           条件不满足时整个按钮不渲染（E2） -->
      <n-button
        v-if="props.executionVisible"
        type="info"
        secondary
        size="tiny"
        class="execute-button"
        :loading="props.executionRunning"
        :disabled="props.executionRunning"
        @click="emit('execute')"
      >
        {{ props.executionRunning ? '执行中…' : '执行测试用例' }}
      </n-button>
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button
            quaternary
            size="tiny"
            class="refresh-button"
            aria-label="刷新文件树"
            :loading="props.refreshing"
            @click="emit('refresh')"
          >
            <n-icon :size="14">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path
                  d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"
                />
              </svg>
            </n-icon>
          </n-button>
        </template>
        刷新文件树
      </n-tooltip>
    </div>
    <n-empty
      v-if="props.nodes.length === 0"
      size="small"
      description="当前 Skill 暂无用户文件"
    />
    <n-tree
      v-else
      v-model:expanded-keys="expandedKeys"
      block-line
      expand-on-click
      :data="options"
      :selected-keys="props.selectedPath ? [props.selectedPath] : []"
      @update:selected-keys="handleSelect"
    />

    <!-- 新建弹窗（v14 W45/W47/W48：直接输入名称；非法即时提示；失败保留输入） -->
    <n-modal :show="pendingCreate !== null" @update:show="closeCreateModal">
      <n-card
        style="width: min(440px, calc(100vw - 32px))"
        :title="pendingCreate?.kind === 'file' ? '新建文件' : '新建目录'"
        :bordered="false"
        role="dialog"
        aria-modal="true"
      >
        <template v-if="pendingCreate !== null">
          <p class="create-hint">
            将在 <b>{{ pendingCreate.parentRelativePath }}</b> 下新建{{
              pendingCreate.kind === 'file' ? '文件' : '目录'
            }}。
          </p>
          <n-input
            v-model:value="createName"
            size="small"
            :placeholder="
              pendingCreate.kind === 'file'
                ? '输入文件名（如 result.csv）'
                : '输入目录名（如 exports）'
            "
            :disabled="creating"
            @keyup.enter="confirmCreate"
          />
          <p v-if="createError" class="create-error">{{ createError }}</p>
        </template>
        <template #footer>
          <div class="delete-modal-footer">
            <n-button
              size="small"
              :disabled="creating"
              @click="closeCreateModal"
              >取消</n-button
            >
            <n-button
              size="small"
              type="primary"
              :loading="creating"
              @click="confirmCreate"
            >
              新建
            </n-button>
          </div>
        </template>
      </n-card>
    </n-modal>

    <!-- 删除确认弹窗（v11 报告 / v13 通用，共用同一弹窗避免两套交互） -->
    <n-modal
      :show="pendingDeleteRunId !== null || pendingDeleteNode !== null"
      @update:show="closeDeleteModal"
    >
      <n-card
        style="width: min(440px, calc(100vw - 32px))"
        :title="pendingDeleteRunId !== null ? '删除测试报告' : '删除确认'"
        :bordered="false"
        role="dialog"
        aria-modal="true"
      >
        <template v-if="pendingDeleteRunId !== null">
          确定删除测试报告
          <b>{{ pendingDeleteRunId }}</b>
          吗？删除后不可恢复。
        </template>

        <template v-else-if="pendingDeleteNode !== null">
          <!-- W16：正文展示完整相对路径（而非仅节点名） -->
          确定删除
          <b class="delete-target-path">{{ pendingDeleteNode.relativePath }}</b>
          吗？
          <p
            v-if="pendingDeleteNode.kind === 'directory'"
            class="delete-warning"
          >
            该目录及其下全部内容都会被删除，且不可恢复。
          </p>
          <!-- 基线删除的后果提示：脚本里的 toMatchSnapshot 依赖基线存在，
               删掉后相关比对会失败，直到重新捕获（v14：路径前缀迁入 userWorkSpace/）。 -->
          <p
            v-if="pendingDeleteNode.relativePath.startsWith('userWorkSpace/')"
            class="delete-warning"
          >
            若删除的是基线图片，引用它的测试脚本在执行时会因缺少基线而比对失败，
            需要重新捕获基线或重新生成脚本。
          </p>
          <!-- 执行中风险提示（场景 15/R4：允许删除，但明示后果、不做回滚） -->
          <p
            v-if="
              executionRunning &&
              pendingDeleteNode.relativePath.startsWith('userWorkSpace/')
            "
            class="delete-warning"
          >
            当前有测试正在执行，删除其可能读取的文件会导致本次测试失败，且不会自动回滚。
          </p>
          <p v-else>删除后不可恢复。</p>
        </template>

        <template #footer>
          <div class="delete-modal-footer">
            <n-button size="small" @click="closeDeleteModal">取消</n-button>
            <n-button size="small" type="error" @click="confirmDelete"
              >删除</n-button
            >
          </div>
        </template>
      </n-card>
    </n-modal>
  </aside>
</template>

<style scoped>
.explorer {
  height: 100%;
  overflow: auto;
  padding: 10px;
  background: var(--color-surface);
}

.explorer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-xs) 6px;
}

.refresh-button {
  color: var(--color-ink-muted);
  /* 执行按钮不渲染时工具栏只剩本按钮：margin-left:auto 保证其恒居右 */
  margin-left: auto;
}

/* 只保留 hover 样式：聚焦与按下时不显示背景框 */
.refresh-button:not(:hover) {
  background: transparent;
}

.refresh-button:focus-visible {
  outline: none;
}

/* 报告删除按钮：默认隐藏，hover 所在树节点行时显示。
   注意：suffix 由渲染函数（h）生成，不带本组件 scoped 属性，
   按钮与树节点 hover 的规则放在下方非 scoped 样式块。 */

.delete-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}

/* 删除后果提示（目录递归删除、基线被脚本引用等）：与正文区分，提醒用户看清 */
.delete-warning {
  margin: 6px 0 0;
  color: var(--color-warning, #b45309);
  font-size: 12.5px;
}

.delete-target-path {
  word-break: break-all;
}

.create-hint {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--color-ink-body);
}

.create-error {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: var(--color-danger, #dc2626);
}

@media (pointer: coarse), (max-width: 760px) {
  .refresh-button {
    min-width: 44px;
    min-height: 44px;
  }

  /* 触控端沿用 44px 最小触控标准（PRD 4.1.1） */
  .execute-button {
    min-height: 44px;
  }
}
</style>

<style>
/* 非 scoped：h() 渲染函数生成的元素不携带 data-v 属性，scoped 规则无法命中。 */

/* 后缀容器：常驻锁标识 + 悬停操作按钮组，二者水平并排。 */
.explorer .tree-node-suffix {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: 4px;
}

/* 悬停操作按钮组：默认隐藏，hover 所在树节点行时显示（W40）。 */
.explorer .tree-node-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-out);
}

.explorer .n-tree-node:hover .tree-node-actions,
.explorer .n-tree-node:focus-within .tree-node-actions,
.explorer .tree-node-actions:focus-visible {
  opacity: 1;
}

/* 受保护节点的锁定图标：常驻显示（W20/W21 的可视语义），低透明度不抢视觉。 */
.explorer .tree-lock-icon {
  color: var(--color-ink-muted);
  opacity: 0.6;
}
</style>
