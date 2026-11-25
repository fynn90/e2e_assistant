/**
 * 编排 Skill 开发页的加载、文件切换、草稿保存、Chat 和离开保护。
 */
import {
  computed,
  onBeforeUnmount,
  ref,
  shallowRef,
  watch,
  type Ref,
} from 'vue'
import {
  isNavigationFailure,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
  type RouteLocationNormalized,
} from 'vue-router'
import { parseRawE2ETestCase } from '../e2e-test-case/utils/parse-raw-test-case'
import { updateE2ETestCase } from '../e2e-test-case/services/e2e-test-case-api'
import { useAutoSave } from '../../common/autosave/useAutoSave'
import {
  createEnvFileTarget,
  createGenericFileTarget,
  createPlaywrightScriptTarget,
  createSkillDocumentTarget,
} from '../../common/autosave/save-targets'
import type { ISaveTarget } from '../../common/autosave/types'
import { useUnloadGuard } from '../../common/autosave/unsaved-guard'
import {
  CHAT_MAX_MESSAGE_CHARACTERS,
  CHAT_MAX_MESSAGES,
  CHAT_MAX_REQUEST_CHARACTERS,
} from '../../common/chat/limits'
import {
  extractEnvFileKeys,
  parseEnvFileContent,
  SKILL_ENV_FILE_NAME,
  type IEnvFileIssue,
} from '@charlie_deng/e2e-assistant-types'
import type { ISkillDetail, ISkillFileTreeNode } from '@charlie_deng/e2e-assistant-types'
import type { IChatMessageViewModel } from '../../common/chat/types'
import { streamSkillChat } from '../../services/chat-api'
import { ApiClientError } from '../../services/http-client'
import { fetchE2ETestCase } from '../e2e-test-case/services/e2e-test-case-api'
import {
  fetchSkill,
  fetchSkillFile,
  fetchSkillFiles,
  updateSkillFile,
} from '../../services/skill-api'
import { useGlobalMessage } from '../../composables/useGlobalMessage'
import {
  createSkillDevelopmentChatLocation,
  createSkillDevelopmentCodeLocation,
  createSkillDevelopmentE2ETestCaseLocation,
  createSkillDevelopmentImageLocation,
  createSkillDevelopmentReportLocation,
  parseSkillDevelopmentWorkspaceTarget,
  type TSkillDevelopmentWorkspaceTarget,
} from '../../router/skill-development-navigation'
import { WORKBENCH_ROUTE_NAMES } from '../../router/workbench-navigation'
import {
  resolveMissingOpenFileAction,
  resolveSkillFileOpenTarget,
} from './skill-file'
import type {
  ICurrentSkillFile,
  IStructuredEditorHandle,
  TSkillDevelopmentPageState,
  TSkillFileNode,
} from './types'

type TUnsavedChangesResolution = 'continue' | 'cancel'

interface ISaveCurrentFileOptions {
  navigateAfterRawSave?: boolean
}

export function useSkillDevelopment (skillId: Ref<string>) {
  const route = useRoute()
  const router = useRouter()
  const message = useGlobalMessage()
  const pageState = ref<TSkillDevelopmentPageState>('loading')
  const errorMessage = ref('')
  const skill = ref<ISkillDetail | null>(null)
  const fileTree = ref<ISkillFileTreeNode[]>([])
  const refreshingTree = ref(false)
  const currentFile = ref<ICurrentSkillFile | null>(null)
  const selectedPath = ref<string | undefined>()
  const structuredDirty = ref(false)
  const structuredEditorHandle = shallowRef<IStructuredEditorHandle | null>(
    null,
  )
  const saving = ref(false)
  const saveState = ref<'idle' | 'saved' | 'failed' | 'conflict'>('idle')
  const unsavedDialogVisible = ref(false)
  let pendingUnsavedResolver:
    ((choice: 'save' | 'discard' | 'cancel') => void) | null = null
  const messages = ref<IChatMessageViewModel[]>([])
  const streaming = ref(false)
  let chatAbortController: AbortController | null = null
  let pageLoadAbortController: AbortController | null = null
  let fileOpenAbortController: AbortController | null = null
  let refreshTreeAbortController: AbortController | null = null
  let workspaceActivationSequence = 0
  /**
   * 当前结构化用例的来源哈希。
   *
   * `SKILL.md` 与 `test.spec.ts` 的实时保存都要把它交给服务端——
   * 服务端据此拒绝「非当前用例派生」的产物，避免陈旧文档被当作权威输入。
   */
  const testCaseSourceHash = ref('')
  /**
   * env.json 的最新合法状态（v10，PRD 6.1.5 / 7.3）。
   *
   * 数据源是磁盘上最近一次合法内容：`status` 驱动结构化用例页的空数据源 /
   * 只读提示，`keys` 驱动「添加敏感数据」与「插入敏感数据引用」两个下拉，
   * `issues` 供 env.json 编辑页与用例页复用格式错误提示。
   * 两个面板在主内容区互斥展示，先后打开即为刷新时机，无需跨面板实时同步。
   */
  const envFileStatus = ref<'loading' | 'ok' | 'missing' | 'invalid'>('loading')
  const envFileKeyList = ref<string[]>([])
  const envFileIssues = ref<IEnvFileIssue[]>([])
  const envFileKeys = computed(() => envFileKeyList.value)
  let envFileRefreshSequence = 0
  /**
   * 保存目标缓存：同一文件复用同一适配器实例。
   *
   * 只按路径缓存（**不含版本**）——适配器内部自行累积期望版本，
   * 若把版本并入缓存键，每次保存成功都会重建适配器并清空编排层的
   * 「上次已保存内容」基准，导致每次输入都多发一次请求。
   */
  let cachedTarget: { relativePath: string; target: ISaveTarget } | null = null
  const textFileDirty = computed(
    () =>
      Boolean(currentFile.value) &&
      currentFile.value?.draftContent !== currentFile.value?.savedContent,
  )
  const dirty = computed(() => textFileDirty.value || structuredDirty.value)

  /**
   * 为当前打开的文件选择保存目标。
   *
   * 文本文件按类型走不同端点（见技术方案 4.6 / v10 7.4）：
   *   - `SKILL.md`     → `PUT /skill-document`（edit 模式，保留结构诊断）
   *   - `test.spec.ts` → `PUT /playwright-script`（edit 模式，不格式化）
   *   - `env.json`     → `PUT /file`（写入前执行 R1–R5 校验，非法阻断落盘）
   *   - 其它文本文件   → `PUT /file`
   *
   * `e2e_schema.json` 不在此列——它由结构化编辑器负责（有独立的校验与草稿
   * 语义与保存流程），强行接入会引入两套草稿来源。
   */
  const currentTarget = computed<ISaveTarget | null>(() => {
    const file = currentFile.value
    if (!file || file.readOnly || file.orphaned) return null

    if (file.relativePath === 'e2e_schema.json') return null

    if (cachedTarget?.relativePath === file.relativePath)
      return cachedTarget.target

    const target =
      file.relativePath === 'SKILL.md'
        ? createSkillDocumentTarget(
          skillId.value,
          testCaseSourceHash.value,
          file.version,
        )
        : file.relativePath === 'test.spec.ts'
          ? createPlaywrightScriptTarget(
            skillId.value,
            testCaseSourceHash.value,
            file.version,
          )
          : file.relativePath === SKILL_ENV_FILE_NAME
            ? createEnvFileTarget(
              skillId.value,
              SKILL_ENV_FILE_NAME,
              file.version,
            )
            : createGenericFileTarget(
              skillId.value,
              file.relativePath,
              file.version,
            )

    cachedTarget = { relativePath: file.relativePath, target }
    return target
  })

  const autoSave = useAutoSave({
    getContent: () => currentFile.value?.draftContent ?? '',
    target: currentTarget,
    onSaved: (result, content) => {
      const file = currentFile.value
      if (file) {
        file.savedContent = content
        file.version = result.version
      }

      // env.json 保存成功 → 刷新合法 key 状态（PRD 6.1.5），
      // 用例页两个下拉在下次进入时即拿到最新 key 列表。
      if (file?.relativePath === SKILL_ENV_FILE_NAME) {
        void refreshEnvFileState()
      }
    },
    onReload: () => void reloadCurrentFile(),
  })

  /**
   * 拉取当前用例的来源哈希，供 SKILL.md 与脚本的实时保存携带。
   *
   * 失败不阻断页面：文件树编辑仍可用（仅产物类文件的实时保存会因缺少
   * 来源哈希被服务端拒绝并显示为保存失败），用户可在修复用例后重试。
   *
   * @returns 拉取完成后的 Promise。
   */
  async function loadTestCaseSourceHash (): Promise<void> {
    try {
      const response = await fetchE2ETestCase(skillId.value)
      testCaseSourceHash.value = response.data.sourceHash
    } catch {
      testCaseSourceHash.value = ''
    }
  }

  /**
   * 重新读取 env.json 的磁盘内容并刷新状态（PRD 6.1.5 刷新时机）。
   *
   * 触发点：页面加载完成、结构化用例面板激活、env.json 实时保存成功。
   * 404（补建失败降级）按 missing 处理；格式非法时保留磁盘内容的问题明细，
   * 此时 keys 维持上一次合法值不变——下拉数据源始终来自最近一次合法内容（PRD 5.3）。
   *
   * @returns 刷新完成后的 Promise。
   * @throws 不抛出异常；读取失败按缺失处理，不阻断页面。
   */
  async function refreshEnvFileState (): Promise<void> {
    const sequence = ++envFileRefreshSequence
    envFileStatus.value = 'loading'

    try {
      const response = await fetchSkillFile(skillId.value, SKILL_ENV_FILE_NAME)
      if (sequence !== envFileRefreshSequence) return
      const parsed = parseEnvFileContent(response.data.content)

      if (parsed.issues.length > 0 || parsed.data === null) {
        // 格式非法：下拉数据源保持最近一次合法内容，不把半成品暴露给用例页。
        envFileStatus.value = 'invalid'
        envFileIssues.value = parsed.issues
        return
      }

      envFileStatus.value = 'ok'
      envFileIssues.value = []
      envFileKeyList.value = extractEnvFileKeys(parsed.data)
    } catch {
      if (sequence !== envFileRefreshSequence) return
      // 404（补建降级）、权限等读取失败：按缺失处理（PRD 6.1.4）。
      envFileStatus.value = 'missing'
      envFileIssues.value = []
    }
  }

  /** env.json 状态的只读视图，经 context 注入结构化用例编辑器与 env 编辑页。 */
  const envFileState = {
    status: envFileStatus,
    keys: envFileKeys,
    issues: envFileIssues,
    refresh: refreshEnvFileState,
  }

  /**
   * 重新从磁盘加载当前文件，放弃本地改动。
   *
   * 用于保存冲突时用户选择「重新加载」（PRD 7.5）。
   *
   * @returns 重新加载完成后的 Promise。
   */
  async function reloadCurrentFile (): Promise<void> {
    const file = currentFile.value
    if (!file) return

    try {
      const response = await fetchSkillFile(skillId.value, file.relativePath)
      currentFile.value = {
        ...response.data,
        savedContent: response.data.content,
        draftContent: response.data.content,
        orphaned: false,
      }
      autoSave.syncFromDisk(response.data.content, response.data.version)
      message.success('已重新加载磁盘内容。')
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : '重新加载文件失败。',
      )
    }
  }

  async function loadPage (): Promise<void> {
    pageLoadAbortController?.abort()
    fileOpenAbortController?.abort()
    refreshTreeAbortController?.abort()
    workspaceActivationSequence += 1
    chatAbortController?.abort()
    streaming.value = false
    const abortController = new AbortController()
    pageLoadAbortController = abortController
    errorMessage.value = ''
    skill.value = null
    fileTree.value = []
    messages.value = []
    currentFile.value = null
    selectedPath.value = undefined
    structuredDirty.value = false
    structuredEditorHandle.value = null

    if (!/^[a-z0-9]{9}$/.test(skillId.value)) {
      pageState.value = 'invalid-id'
      pageLoadAbortController = null
      return
    }

    pageState.value = 'loading'

    try {
      const [skillResponse, treeResponse] = await Promise.all([
        fetchSkill(skillId.value, abortController.signal),
        fetchSkillFiles(skillId.value, abortController.signal),
      ])

      if (abortController.signal.aborted) return
      skill.value = skillResponse.data
      fileTree.value = treeResponse.data
      pageState.value = 'ready'
      // 产物类文件（SKILL.md / test.spec.ts）的实时保存需要来源哈希，页面就绪后补拉。
      void loadTestCaseSourceHash()
      // v10：页面就绪后读取 env.json 合法状态（此时存量补建已完成）。
      void refreshEnvFileState()
    } catch (error) {
      if (!(error instanceof ApiClientError && error.kind === 'aborted')) {
        applyPageError(error)
      }
    } finally {
      if (pageLoadAbortController === abortController) {
        pageLoadAbortController = null
      }
    }
  }

  /**
   * 重新拉取文件树。
   *
   * @param options.suppressMissingNotice - 静默「当前文件已不存在」的处理（v13）。
   *   默认（false）用于**外部删除**场景：磁盘上的文件被别处删掉了，用户没做任何操作，
   *   因此需要明确告知，并把 Code 面板关掉或转为只读缓冲区（PRD v4 §8.2）。
   *   传 true 用于**用户主动删除**：调用方已经知道了（自己刚点的删除），
   *   再报一次「文件已不存在」是误报；此时由调用方负责接续导航。
   * @returns 刷新成功返回 true；被中止或失败返回 false。
   * @throws 不抛出异常，失败通过全局消息提示。
   */
  async function refreshTree (
    options: { suppressMissingNotice?: boolean } = {},
  ): Promise<boolean> {
    refreshTreeAbortController?.abort()
    const abortController = new AbortController()
    const requestSkillId = skillId.value
    refreshTreeAbortController = abortController
    refreshingTree.value = true

    try {
      const response = await fetchSkillFiles(
        requestSkillId,
        abortController.signal,
      )
      if (abortController.signal.aborted || skillId.value !== requestSkillId)
        return false

      fileTree.value = response.data
      const activeRouteTarget = parseSkillDevelopmentWorkspaceTarget(route)

      if (
        currentFile.value &&
        !treeContainsPath(fileTree.value, currentFile.value.relativePath)
      ) {
        const missingPath = currentFile.value.relativePath
        const action = resolveMissingOpenFileAction({
          hasUnsavedChanges: textFileDirty.value,
          userInitiated: options.suppressMissingNotice === true,
        })

        if (action.type === 'preserve-orphan') {
          // 未保存内容必须保留（PRD v4 §8.2）：保留为不可保存的临时缓冲区供复制。
          currentFile.value.orphaned = true
          currentFile.value.readOnly = true
          // 自己刚删的东西不需要被告知「文件不存在」。
          if (!options.suppressMissingNotice) {
            message.error('文件已不存在，已保留未保存内容供复制。')
          }
        } else {
          currentFile.value = null
          selectedPath.value = undefined

          // 静默模式（用户主动删除）不提示、也不在此处导航：由调用方接续。
          if (action.type === 'clear-and-notice') {
            message.error('文件已不存在。')

            if (
              activeRouteTarget?.panel === 'code' &&
              activeRouteTarget.relativePath === missingPath
            ) {
              await router.replace(
                createSkillDevelopmentChatLocation(skillId.value),
              )
            }
          }
        }
      }

      // 同上：用户主动删除时跳过。`e2e_schema.json` 目前受创建期保护、不会被删，
      // 这里同样纳入开关是为了避免保护清单将来变动时留下不一致的行为。
      if (
        !options.suppressMissingNotice &&
        !currentFile.value &&
        selectedPath.value === 'e2e_schema.json' &&
        !treeContainsPath(fileTree.value, 'e2e_schema.json')
      ) {
        if (structuredDirty.value) {
          structuredEditorHandle.value?.markSourceMissing()
          message.error('e2e_schema.json 已不存在，已保留未保存草稿供复制。')
        } else {
          selectedPath.value = undefined
          message.error('e2e_schema.json 已不存在。')

          if (activeRouteTarget?.panel === 'e2e-test-case') {
            await router.replace(
              createSkillDevelopmentChatLocation(skillId.value),
            )
          }
        }
      }
      return true
    } catch (error) {
      if (!(error instanceof ApiClientError && error.kind === 'aborted')) {
        message.error(
          error instanceof Error ? error.message : '刷新文件树失败。',
        )
      }
      return false
    } finally {
      if (refreshTreeAbortController === abortController) {
        refreshTreeAbortController = null
        refreshingTree.value = false
      }
    }
  }

  // 手动刷新文件树的节流间隔（毫秒）
  const MANUAL_TREE_REFRESH_INTERVAL = 3000
  let lastManualTreeRefreshAt = 0

  /**
   * 手动刷新文件树：3 秒节流，刷新成功后提示；点击过快时提醒用户稍后再试。
   * @returns 刷新或节流提示结束后兑现的 Promise。
   * @throws 请求异常由 refreshTree 内部捕获并转换为错误提示。
   */
  async function refreshTreeManually (): Promise<void> {
    const now = Date.now()
    const remaining =
      MANUAL_TREE_REFRESH_INTERVAL - (now - lastManualTreeRefreshAt)
    if (remaining > 0) {
      message.warning(`操作太频繁，请 ${Math.ceil(remaining / 1000)} 秒后再试`)
      return
    }

    lastManualTreeRefreshAt = now
    const refreshed = await refreshTree()
    if (refreshed) {
      message.success('文件树已刷新')
    }
  }

  /**
   * 重载结构化用例文档状态（v13）。
   *
   * 供删除入口在跳转到用例面板后调用：编辑器持有的 `skillDocument` 是**加载时**
   * 的快照（`exists` / `version` / `status`），而 keep-alive 会缓存面板组件、
   * `onMounted` 不再触发——删除 SKILL.md 后不主动重载，生成按钮会停在
   * 「更新 Skill 文档」并因版本比对被服务端拒绝（报「已在外部修改」）。
   *
   * 重载后 `exists` 变 false，按钮文案自动切回「生成 Skill 文档」。
   *
   * 编辑器未挂载（句柄为 null）时静默跳过：此时该面板尚未加载过文档状态，
   * 其挂载时的 `onMounted` 自然会拉到最新数据。
   *
   * @returns 重载完成后兑现的 Promise。
   * @throws 不抛出异常；重载失败由编辑器内部处理。
   */
  async function reloadStructuredDocument (): Promise<void> {
    try {
      await structuredEditorHandle.value?.reload()
    } catch {
      // 重载失败不影响删除结果：用户重新进入面板时仍会拉到最新状态。
    }
  }

  /**
   * 当前 Skill 是否可以发起执行（文件树顶部按钮的显示条件，PRD E1/E3/E5/E6）。
   *
   * 根目录存在 `test.spec.ts` 且 Skill 非只读；数据源是 fileTree 响应式数据，
   * 执行中脚本被删除（E5）或执行结束（E6）随文件树刷新自然生效。
   */
  const executionVisible = computed(
    () =>
      treeContainsPath(fileTree.value, 'test.spec.ts') &&
      skill.value?.readOnly !== true,
  )

  /**
   * 执行发起前置（PRD J3 的前端半边，技术方案 §7.5）。
   *
   * 文本文件草稿先静默落盘；结构化用例存在未保存修改时不自动保存、直接阻断——
   * 保证「用户看到的内容 = 执行的内容」（快照语义 X1）。
   *
   * @returns 允许发起执行时返回 true；存在未保存修改且无法静默解决时返回 false。
   * @throws 不抛出异常；保存错误通过全局消息提示。
   */
  async function prepareForExecution (): Promise<boolean> {
    if (structuredDirty.value) {
      message.error('存在未保存的用例修改，请先保存后再执行。')
      return false
    }

    if (textFileDirty.value && currentTarget.value) {
      await autoSave.flushSilently()

      if (textFileDirty.value) {
        message.error(
          autoSave.errorMessage.value || '存在未保存的修改，请先保存后再执行。',
        )
        return false
      }
    }

    return true
  }

  /**
   * 将文件树点击转换为对应工作区命名路由导航。
   *
   * 分流优先级由 `resolveSkillFileOpenTarget` 决定（纯函数，可单测）——
   * 本函数只负责把目标翻译成导航动作。
   *
   * @param node 用户选中的文件树节点。
   * @returns 导航完成或目标已是当前路由时返回 true；守卫取消导航时返回 false。
   * @throws 不主动抛出异常，导航失败由 Vue Router 处理。
   */
  async function openFile (node: ISkillFileTreeNode): Promise<boolean> {
    const target = resolveSkillFileOpenTarget(node)
    if (!target) return false

    if (target.type === 'notice') {
      message.warning(target.message)
      return false
    }

    if (target.type === 'image') {
      return navigateToImage(target.relativePath)
    }

    if (target.type === 'report') {
      return navigateToReport(target.runId)
    }

    const location =
      target.type === 'e2e-test-case'
        ? createSkillDevelopmentE2ETestCaseLocation(skillId.value)
        : createSkillDevelopmentCodeLocation(skillId.value, target.relativePath)

    if (router.resolve(location).fullPath === route.fullPath) {
      return true
    }

    const failure = await router.push(location)
    return !isNavigationFailure(failure)
  }

  /**
   * 导航到指定运行时间戳的报告视图。
   * @param runId 报告运行时间戳（yyyyMMdd-HHmmss）。
   * @returns 导航完成或目标已是当前路由时返回 true；守卫取消导航时返回 false。
   * @throws 不主动抛出异常，导航失败由 Vue Router 处理。
   */
  async function navigateToReport (runId: string): Promise<boolean> {
    const target = createSkillDevelopmentReportLocation(skillId.value, runId)

    if (router.resolve(target).fullPath === route.fullPath) {
      return true
    }

    const failure = await router.push(target)
    return !isNavigationFailure(failure)
  }

  /**
   * 导航到图片预览视图（v13）。
   * @param relativePath 图片在 Skill 内的相对路径。
   * @returns 导航完成或目标已是当前路由时返回 true；守卫取消导航时返回 false。
   * @throws 不主动抛出异常，导航失败由 Vue Router 处理。
   */
  async function navigateToImage (relativePath: string): Promise<boolean> {
    const target = createSkillDevelopmentImageLocation(
      skillId.value,
      relativePath,
    )

    if (router.resolve(target).fullPath === route.fullPath) {
      return true
    }

    const failure = await router.push(target)
    return !isNavigationFailure(failure)
  }

  /**
   * 导航到 e2e_schema.json 的原始代码编辑工作区。
   * @returns 路由导航完成后兑现的 Promise。
   * @throws 不主动抛出异常，导航失败由 Vue Router 处理。
   */
  async function openRawE2ETestCase (): Promise<void> {
    await router.push(
      createSkillDevelopmentCodeLocation(skillId.value, 'e2e_schema.json'),
    )
  }

  /**
   * 根据当前子路由激活 Chat、结构化 E2E 或代码文件资源。
   * @param target 已通过路由契约解析的工作区目标。
   * @returns 目标成功激活时返回 true；文件缺失或加载失败时返回 false。
   * @throws 不抛出异常，资源错误通过全局消息展示并回退到 Chat。
   */
  async function activateWorkspaceTarget (
    target: TSkillDevelopmentWorkspaceTarget,
  ): Promise<boolean> {
    workspaceActivationSequence += 1
    const activationSequence = workspaceActivationSequence
    fileOpenAbortController?.abort()

    if (target.panel === 'chat') {
      return true
    }

    if (target.panel === 'report') {
      // v11 报告视图（PRD V3/V4）：清空文本文件状态，文件树选中报告文件。
      // 目录链路的展开由页面（expandedKeys 持有方）在路由变化时处理。
      const reportPath = `test_report/${target.runId}/report.html`
      currentFile.value = null
      selectedPath.value = treeContainsPath(fileTree.value, reportPath)
        ? reportPath
        : undefined
      return true
    }

    if (target.panel === 'image') {
      // v13 图片预览：图片不经文本编辑器加载（服务端会拒二进制），
      // 路径本身就是要展示的全部信息，因此不做存在性校验——
      // 文件若已失效，面板内的查看器会自行降级为「无法显示这张图片」。
      currentFile.value = null
      selectedPath.value = treeContainsPath(fileTree.value, target.relativePath)
        ? target.relativePath
        : undefined
      return true
    }

    if (target.panel === 'e2e-test-case') {
      if (!treeContainsPath(fileTree.value, 'e2e_schema.json')) {
        message.error('e2e_schema.json 不存在。')
        // 回退到 Chat 而不是默认工作区：默认工作区（结构化用例面板）**以
        // e2e_schema.json 为数据源**，回退到那里只会立刻再报一次同样的错，
        // 用户被卡在一个必然报错的空面板上。Chat 不依赖任何 Skill 文件。
        // （注意：进入 Skill 的**落地页**用 createSkillDevelopmentDefaultLocation，
        // 那是产品刻意选择 E2E 面板，与此处的异常回退是两回事。）
        await router.replace(createSkillDevelopmentChatLocation(skillId.value))
        return false
      }

      currentFile.value = null
      selectedPath.value = 'e2e_schema.json'
      saveState.value = 'idle'
      // v10：进入结构化用例面板时重读 env.json（PRD 6.1.5 刷新时机），
      // 保证下拉数据源与失效判定基于磁盘最新合法内容。
      void refreshEnvFileState()
      return true
    }

    if (currentFile.value?.relativePath === target.relativePath) {
      selectedPath.value = target.relativePath
      return true
    }

    const node = findFileNode(fileTree.value, target.relativePath)
    if (!node) {
      message.error('目标文件不存在。')
      await router.replace(createSkillDevelopmentChatLocation(skillId.value))
      return false
    }

    return openTextFile(node, activationSequence)
  }

  /**
   * 加载并激活指定文本文件；同一健康文件会直接复用现有草稿和 Monaco 实例。
   * @param node 待打开的文件节点。
   * @param activationSequence 发起加载时的工作区激活序号。
   * @returns 文件成功加载时返回 true，否则返回 false。
   * @throws 不抛出异常，底层读取错误通过全局消息展示。
   */
  async function openTextFile (
    node: TSkillFileNode,
    activationSequence: number,
  ): Promise<boolean> {
    const requestSkillId = skillId.value
    const abortController = new AbortController()
    fileOpenAbortController = abortController

    try {
      const response = await fetchSkillFile(
        requestSkillId,
        node.relativePath,
        abortController.signal,
      )

      const activeTarget = parseSkillDevelopmentWorkspaceTarget(route)
      if (
        abortController.signal.aborted ||
        workspaceActivationSequence !== activationSequence ||
        skillId.value !== requestSkillId ||
        activeTarget?.panel !== 'code' ||
        activeTarget.relativePath !== node.relativePath
      ) {
        return false
      }
      currentFile.value = {
        ...response.data,
        savedContent: response.data.content,
        draftContent: response.data.content,
        orphaned: false,
      }
      selectedPath.value = node.relativePath
      structuredDirty.value = false
      saveState.value = 'idle'
      // 用磁盘内容重置实时保存基准：换文件后「跳过无变化」判定需要以
      // 新文件的磁盘内容为参照，否则首次输入会与旧文件的基准比较。
      autoSave.syncFromDisk(response.data.content, response.data.version)
      return true
    } catch (error) {
      const activeTarget = parseSkillDevelopmentWorkspaceTarget(route)
      const requestIsCurrent =
        workspaceActivationSequence === activationSequence &&
        skillId.value === requestSkillId &&
        activeTarget?.panel === 'code' &&
        activeTarget.relativePath === node.relativePath

      if (
        requestIsCurrent &&
        !(error instanceof ApiClientError && error.kind === 'aborted')
      ) {
        message.error(error instanceof Error ? error.message : '打开文件失败。')
        await router.replace(createSkillDevelopmentChatLocation(skillId.value))
      }
      return false
    } finally {
      if (fileOpenAbortController === abortController) {
        fileOpenAbortController = null
      }
    }
  }

  /**
   * 注册结构化编辑器暴露的保存、丢弃和重载句柄。
   * @param handle 当前结构化编辑器句柄；组件卸载时传入 null。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function registerStructuredEditor (
    handle: IStructuredEditorHandle | null,
  ): void {
    structuredEditorHandle.value = handle
  }

  function setStructuredDirty (value: boolean): void {
    structuredDirty.value = value
  }

  function updateSkillProjection (data: {
    title: string
    description: string
  }): void {
    if (skill.value) {
      skill.value = {
        ...skill.value,
        title: data.title,
        description: data.description,
      }
    }
  }

  // 用户输入 → 同步标记待保存。
  //
  // 编辑器绑定本地 ref，输入上屏与保存完全解耦（PRD 7.3「输入永不阻塞」）：
  // 这里只做一次同步状态写入 + 定时器重置，不 await 任何 Promise。
  watch(
    () => currentFile.value?.draftContent,
    (draft) => {
      const file = currentFile.value
      if (!file || file.readOnly || file.orphaned) return
      // 内容与磁盘一致（未改动或已改回原样）时不标记，避免无意义请求。
      if (draft === file.savedContent) return
      autoSave.markDirty()
    },
  )

  // 保存状态变化 → 同步到页头与编辑器工具栏展示的 saveState。
  // blocked（v10 校验阻断）不映射为页头的「保存失败」：其专属呈现是
  // env.json 编辑页的校验反馈区与「保存被阻止」徽标，页头保持安静。
  watch(
    () => autoSave.state.value,
    (state) => {
      saveState.value =
        state === 'failed'
          ? 'failed'
          : state === 'conflict'
            ? 'conflict'
            : state === 'saved'
              ? 'saved'
              : 'idle'
    },
  )

  function getSavedFileContext (): { relativePath: string; version: string } | undefined {
    if (currentFile.value) {
      return {
        relativePath: currentFile.value.relativePath,
        version: currentFile.value.version,
      }
    }

    return selectedPath.value === 'e2e_schema.json'
      ? structuredEditorHandle.value?.getSavedFileContext()
      : undefined
  }

  /**
   * 保存当前文件。
   *
   * v9 起普通文本文件默认由实时保存自动落盘，本函数成为「立即保存」
   * （Ctrl+S 或页头保存按钮），语义等同提前触发一次 flush。
   * `e2e_schema.json` 例外：它仍走结构化编辑器的独立保存流程。
   *
   * @param options - 保存选项（是否在保存后导航回结构化面板）。
   * @returns 保存成功时返回 true。
   */
  async function saveCurrentFile (
    options: ISaveCurrentFileOptions = {},
  ): Promise<boolean> {
    const file = currentFile.value

    if (!file || file.readOnly || file.orphaned || saving.value) {
      return false
    }

    if (file.relativePath === 'e2e_schema.json') {
      if (!textFileDirty.value) return true
      return saveRawE2ETestCase(file, options.navigateAfterRawSave !== false)
    }

    if (!textFileDirty.value) {
      return true
    }

    saving.value = true
    try {
      const saved = await autoSave.saveNow()
      if (saved) {
        message.success('已保存')
      } else {
        message.error(autoSave.errorMessage.value || '保存失败。')
      }
      return saved
    } finally {
      saving.value = false
    }
  }

  async function saveRawE2ETestCase (
    file: ICurrentSkillFile,
    navigateAfterSave: boolean,
  ): Promise<boolean> {
    saving.value = true
    saveState.value = 'idle'

    try {
      const testCase = parseRawE2ETestCase(file.draftContent)
      const response = await updateE2ETestCase(skillId.value, {
        testCase,
        expectedVersion: file.version,
      })
      updateSkillProjection(response.data)
      currentFile.value = null
      selectedPath.value = 'e2e_schema.json'
      structuredDirty.value = false
      saveState.value = 'saved'

      if (navigateAfterSave) {
        await structuredEditorHandle.value?.reload()
        await router.replace(
          createSkillDevelopmentE2ETestCaseLocation(skillId.value),
        )
      }

      message.success('原始 JSON 已修复并通过结构化校验。')
      return true
    } catch (error) {
      saveState.value =
        error instanceof ApiClientError &&
          error.code === 'FILE_VERSION_CONFLICT'
          ? 'conflict'
          : 'failed'
      message.error(
        error instanceof Error ? error.message : '保存原始 E2E JSON 失败。',
      )
      return false
    } finally {
      saving.value = false
    }
  }

  async function returnToWorkbench (): Promise<void> {
    await router.push({ name: WORKBENCH_ROUTE_NAMES.skills })
  }

  async function sendChat (content: string): Promise<void> {
    if (streaming.value) return
    const userMessage: IChatMessageViewModel = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      status: 'complete',
    }
    const assistantMessage: IChatMessageViewModel = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      status: 'streaming',
      toolCalls: [],
    }
    messages.value.push(userMessage, assistantMessage)
    await runAssistant(messages.value.length - 2, messages.value.length - 1)
  }

  async function retryChat (messageId: string): Promise<void> {
    if (streaming.value) return
    const assistantIndex = messages.value.findIndex(
      (item) => item.id === messageId,
    )
    const userIndex = assistantIndex - 1

    if (
      assistantIndex < 1 ||
      messages.value[assistantIndex].role !== 'assistant' ||
      messages.value[userIndex]?.role !== 'user'
    ) {
      return
    }

    messages.value[assistantIndex].content = ''
    messages.value[assistantIndex].status = 'streaming'
    messages.value[assistantIndex].contextFile = undefined
    messages.value[assistantIndex].contextWarnings = undefined
    messages.value[assistantIndex].toolCalls = []
    await runAssistant(userIndex, assistantIndex)
  }

  function stopChat (): void {
    chatAbortController?.abort()
  }

  async function runAssistant (
    userIndex: number,
    assistantIndex: number,
  ): Promise<void> {
    const assistantMessage = messages.value[assistantIndex]
    const abortController = new AbortController()
    chatAbortController = abortController
    streaming.value = true
    let streamErrorMessage = ''
    let pendingDelta = ''
    let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null
    const flushPendingDelta = () => {
      if (deltaFlushTimer) {
        clearTimeout(deltaFlushTimer)
        deltaFlushTimer = null
      }

      if (pendingDelta) {
        assistantMessage.content += pendingDelta
        pendingDelta = ''
      }
    }
    const queueDelta = (text: string) => {
      pendingDelta += text

      if (!deltaFlushTimer) {
        deltaFlushTimer = setTimeout(flushPendingDelta, 32)
      }
    }

    /**
     * 按 toolCallId 合并服务端推送的工具安全投影。
     *
     * @param tool - 当前工具调用的完整安全视图。
     */
    const mergeToolCall = (
      tool: NonNullable<typeof assistantMessage.toolCalls>[number],
    ) => {
      const calls =
        assistantMessage.toolCalls ?? (assistantMessage.toolCalls = [])
      const index = calls.findIndex(
        (item) => item.toolCallId === tool.toolCallId,
      )
      if (index < 0) {
        calls.push(tool)
      } else {
        calls[index] = tool
      }
      calls.sort((left, right) => left.sequence - right.sequence)
    }

    try {
      await streamSkillChat({
        skillId: skillId.value,
        signal: abortController.signal,
        request: {
          messages: buildChatRequestMessages(userIndex),
          currentFile: getSavedFileContext(),
        },
        onEvent (event) {
          if (event.type === 'start') {
            assistantMessage.contextFile = event.currentFile
            assistantMessage.contextWarnings = event.contextWarnings
          } else if (event.type === 'delta') {
            queueDelta(event.text)
          } else if (event.type === 'tool') {
            mergeToolCall(event.tool)
          } else if (event.type === 'complete') {
            flushPendingDelta()
            assistantMessage.status = 'complete'
          } else if (event.type === 'error') {
            streamErrorMessage = event.message
          }
        },
      })

      if (streamErrorMessage) {
        assistantMessage.status = 'failed'
        message.error(streamErrorMessage)
      } else if (assistantMessage.status === 'streaming') {
        assistantMessage.status = 'complete'
      }
    } catch (error) {
      if (error instanceof ApiClientError && error.kind === 'aborted') {
        assistantMessage.status = 'stopped'
      } else {
        assistantMessage.status = 'failed'
        message.error(
          error instanceof Error ? error.message : 'Chat 请求失败。',
        )
      }
    } finally {
      flushPendingDelta()

      if (chatAbortController === abortController) {
        streaming.value = false
        chatAbortController = null
      }
    }
  }

  function buildChatRequestMessages (userIndex: number) {
    const requestMessages = messages.value
      .slice(0, userIndex + 1)
      .filter(
        (item) =>
          item.role === 'user' ||
          (item.role === 'assistant' && item.status === 'complete'),
      )
      .map((item) => ({
        role: item.role,
        content: item.content.slice(0, CHAT_MAX_MESSAGE_CHARACTERS),
      }))
      .slice(-CHAT_MAX_MESSAGES)
    let totalCharacters = requestMessages.reduce(
      (total, item) => total + item.content.length,
      0,
    )

    while (
      requestMessages.length > 1 &&
      totalCharacters > CHAT_MAX_REQUEST_CHARACTERS
    ) {
      const removedMessage = requestMessages.shift()
      totalCharacters -= removedMessage?.content.length ?? 0
    }

    return requestMessages
  }

  function discardUnsavedChanges (): void {
    if (structuredDirty.value) {
      structuredEditorHandle.value?.discard()
      structuredDirty.value = false
    }

    if (textFileDirty.value && currentFile.value) {
      currentFile.value.draftContent = currentFile.value.savedContent
    }
  }

  async function resolveUnsavedChanges (): Promise<TUnsavedChangesResolution> {
    if (!dirty.value) {
      return 'continue'
    }

    // v9：普通文本文件由实时保存负责落盘，离开前先**静默 flush 一次**（用户无感）。
    // 只有 flush 之后仍无法自动解决的保存问题（failed / conflict）才需要打扰用户；
    // 这样切换文件不再弹出「保存 / 放弃 / 取消」三选一对话框（PRD 7.6）。
    //
    // `structuredDirty` 与 `currentTarget === null`（e2e_schema.json 原始 JSON 模式）
    // 不在此列：它们有自己的草稿语义与保存流程。
    if (textFileDirty.value && !structuredDirty.value && currentTarget.value) {
      await autoSave.flushSilently()
      if (!textFileDirty.value) return 'continue'
      if (
        autoSave.state.value !== 'failed' &&
        autoSave.state.value !== 'conflict'
      ) {
        return 'continue'
      }
    }

    const choice = await confirmUnsavedChanges()

    if (choice === 'cancel') {
      return 'cancel'
    }

    if (choice === 'save') {
      const saved = structuredDirty.value
        ? structuredEditorHandle.value
          ? await structuredEditorHandle.value.save()
          : false
        : await saveCurrentFile({ navigateAfterRawSave: false })
      return saved ? 'continue' : 'cancel'
    }

    discardUnsavedChanges()
    return 'continue'
  }

  function confirmUnsavedChanges (): Promise<'save' | 'discard' | 'cancel'> {
    pendingUnsavedResolver?.('cancel')
    unsavedDialogVisible.value = true

    return new Promise((resolve) => {
      pendingUnsavedResolver = resolve
    })
  }

  function resolveUnsavedDialog (choice: 'save' | 'discard' | 'cancel'): void {
    const resolve = pendingUnsavedResolver

    if (!resolve) {
      return
    }

    pendingUnsavedResolver = null
    unsavedDialogVisible.value = false
    resolve(choice)
  }

  function confirmUnsavedSave (): void {
    resolveUnsavedDialog('save')
  }

  function confirmUnsavedDiscard (): void {
    resolveUnsavedDialog('discard')
  }

  function cancelUnsavedNavigation (): void {
    resolveUnsavedDialog('cancel')
  }

  function applyPageError (error: unknown): void {
    errorMessage.value =
      error instanceof Error ? error.message : 'Skill 加载失败。'

    if (!(error instanceof ApiClientError)) {
      pageState.value = 'error'
      return
    }

    if (error.kind === 'network' || error.kind === 'protocol') {
      pageState.value = 'service-unavailable'
    } else if (error.code === 'SKILL_NOT_FOUND') {
      pageState.value = 'not-found'
    } else if (error.code === 'SKILL_CORRUPTED') {
      pageState.value = 'corrupted'
    } else if (error.code === 'SKILL_PERMISSION_DENIED') {
      pageState.value = 'permission-denied'
    } else if (error.code === 'INVALID_SKILL_ID') {
      pageState.value = 'invalid-id'
    } else {
      pageState.value = 'error'
    }
  }

  // 页面卸载守卫：尽力而为触发一次落盘（真正的保障是 800ms 防抖落盘，PRD 7.6）。
  useUnloadGuard({
    isDirty: () => dirty.value,
    flush: () => autoSave.flushSilently(),
  })

  /**
   * 返回当前内存中仍被保留的可编辑资源，用于判断路由更新是否会替换草稿。
   * @returns Chat、结构化 E2E 或代码文件目标。
   * @throws 不抛出异常。
   */
  function getRetainedWorkspaceTarget (): TSkillDevelopmentWorkspaceTarget {
    if (currentFile.value) {
      return { panel: 'code', relativePath: currentFile.value.relativePath }
    }

    if (selectedPath.value === 'e2e_schema.json') {
      return { panel: 'e2e-test-case' }
    }

    // v11：报告视图保留中（selectedPath 指向报告文件且当前路由为报告面板）。
    // v13：图片预览同理——两者都不持有 currentFile，靠路由自身表达当前资源。
    const activeTarget = parseSkillDevelopmentWorkspaceTarget(route)
    if (activeTarget?.panel === 'report' || activeTarget?.panel === 'image') {
      return activeTarget
    }

    return { panel: 'chat' }
  }

  /**
   * 判断两个工作区目标是否指向同一可编辑资源。
   * @param left 第一个工作区目标。
   * @param right 第二个工作区目标。
   * @returns 两个目标指向同一面板和文件时返回 true。
   * @throws 不抛出异常。
   */
  function isSameWorkspaceTarget (
    left: TSkillDevelopmentWorkspaceTarget,
    right: TSkillDevelopmentWorkspaceTarget,
  ): boolean {
    if (left.panel !== right.panel) {
      return false
    }

    if (left.panel === 'code') {
      return right.panel === 'code' && left.relativePath === right.relativePath
    }

    if (left.panel === 'report') {
      return right.panel === 'report' && left.runId === right.runId
    }

    // 图片与代码面板同样按路径区分：漏掉这一支会让「两张不同的图片」
    // 被判定为同一目标，从而错误跳过离开确认等按目标比较的逻辑。
    if (left.panel === 'image') {
      return right.panel === 'image' && left.relativePath === right.relativePath
    }

    return true
  }

  /**
   * 处理离开 Skill 开发页的未保存修改确认。
   * @returns 允许离开时返回 true，用户取消时返回 false。
   * @throws 不抛出异常。
   */
  async function resolveRouteLeave (): Promise<boolean> {
    return (await resolveUnsavedChanges()) === 'continue'
  }

  /**
   * 处理 Skill 开发父路由复用时的语义化未保存修改确认。
   * @param to 即将进入的目标路由。
   * @returns 允许更新时返回 true，用户取消时返回 false。
   * @throws 不抛出异常。
   */
  async function resolveRouteUpdate (
    to: RouteLocationNormalized,
  ): Promise<boolean> {
    if (!dirty.value) {
      return true
    }

    const targetSkillId =
      typeof to.params.skillId === 'string' ? to.params.skillId : ''
    if (targetSkillId !== skillId.value) {
      return resolveRouteLeave()
    }

    const nextTarget = parseSkillDevelopmentWorkspaceTarget(to)
    if (nextTarget?.panel === 'chat') {
      return true
    }

    if (
      nextTarget &&
      isSameWorkspaceTarget(nextTarget, getRetainedWorkspaceTarget())
    ) {
      return true
    }

    return resolveRouteLeave()
  }

  onBeforeRouteLeave(resolveRouteLeave)
  onBeforeRouteUpdate(resolveRouteUpdate)
  onBeforeUnmount(() => {
    resolveUnsavedDialog('cancel')
    pageLoadAbortController?.abort()
    fileOpenAbortController?.abort()
    refreshTreeAbortController?.abort()
    workspaceActivationSequence += 1
    chatAbortController?.abort()
  })

  return {
    pageState,
    errorMessage,
    skill,
    fileTree,
    refreshingTree,
    currentFile,
    selectedPath,
    saving,
    saveState,
    unsavedDialogVisible,
    dirty,
    /** 实时保存状态（卡片与编辑器工具栏的保存徽标数据源）。 */
    autoSaveState: autoSave.state,
    /** 实时保存的校验诊断（edit 模式下不阻断写入，仅提示）。 */
    autoSaveDiagnostics: autoSave.diagnostics,
    /** 实时保存的校验阻断问题明细（blocked 态专属，v10）。 */
    autoSaveBlockedIssues: autoSave.blockedIssues,
    /** 实时保存错误文案（错误条展示）。 */
    autoSaveErrorMessage: autoSave.errorMessage,
    /** env.json 最新合法状态（下拉数据源与失效判定，v10）。 */
    envFileState,
    /** 用户选择「重试保存」。 */
    retryAutoSave: autoSave.retry,
    /** 用户选择「重新加载」：放弃本地改动。 */
    reloadAutoSave: autoSave.reload,
    messages,
    streaming,
    /** 执行按钮的显示条件（PRD E1/E3，v11）。 */
    executionVisible,
    /** 执行发起前置：J3 静默落盘与阻断判定（v11）。 */
    prepareForExecution,
    loadPage,
    refreshTree,
    refreshTreeManually,
    reloadStructuredDocument,
    openFile,
    activateWorkspaceTarget,
    openRawE2ETestCase,
    structuredEditorHandle,
    registerStructuredEditor,
    setStructuredDirty,
    updateSkillProjection,
    saveCurrentFile,
    confirmUnsavedSave,
    confirmUnsavedDiscard,
    cancelUnsavedNavigation,
    returnToWorkbench,
    sendChat,
    retryChat,
    stopChat,
  }
}

function treeContainsPath (
  nodes: ISkillFileTreeNode[],
  relativePath: string,
): boolean {
  return Boolean(findFileNode(nodes, relativePath))
}

/**
 * 在嵌套文件树中查找指定相对路径的文件节点。
 * @param nodes 当前层级文件树节点。
 * @param relativePath 目标 Skill 相对路径。
 * @returns 匹配的文件节点；不存在时返回 undefined。
 * @throws 不抛出异常。
 */
function findFileNode (
  nodes: ISkillFileTreeNode[],
  relativePath: string,
): Extract<ISkillFileTreeNode, { kind: 'file' }> | undefined {
  for (const node of nodes) {
    if (node.kind === 'file' && node.relativePath === relativePath) {
      return node
    }

    if (node.kind === 'directory') {
      const child = findFileNode(node.children, relativePath)
      if (child) {
        return child
      }
    }
  }

  return undefined
}
