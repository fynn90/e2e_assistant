/**
 * 管理结构化 E2E 用例的加载、独立草稿、字段校验、保存和冲突恢复。
 */
import { computed, onBeforeUnmount, ref, type Ref } from 'vue'
import type {
  IE2ETestCase,
  IE2ETestCaseDocumentData,
  IPlaywrightScriptState,
  ISkillDocumentState,
} from '@authine-e2e-agent/types'
import { useGlobalMessage } from '../../../composables/useGlobalMessage'
import { ApiClientError } from '../../../services/http-client'
import {
  fetchE2ETestCase,
  updateE2ETestCase,
} from '../services/e2e-test-case-api'
import { cloneTestCaseDraft } from '../utils/test-case-draft'
import {
  getDraftGenerationIssues,
  getDraftSaveIssues,
  issuesToFieldErrors,
  type TFieldErrorMap,
} from '../validation/test-case-form-validator'

export type TE2ETestCaseEditorStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'invalid'
  | 'conflicted'
  | 'missing'
  | 'error'

export function useE2ETestCase(
  skillId: Ref<string>,
  callbacks: {
    onSaved?: (data: {
      title: string
      description: string
      version: string
      generationReady: boolean
    }) => void
  } = {},
) {
  const message = useGlobalMessage()
  const savedTestCase = ref<IE2ETestCase | null>(null)
  const draft = ref<IE2ETestCase | null>(null)
  const version = ref('')
  const sourceHash = ref('')
  const script = ref<IPlaywrightScriptState | null>(null)
  const skillDocument = ref<ISkillDocumentState | null>(null)
  const status = ref<TE2ETestCaseEditorStatus>('idle')
  const errorMessage = ref('')
  const loadErrorCode = ref<string | undefined>()
  const fieldErrors = ref<TFieldErrorMap>({})
  const conflictDocument = ref<IE2ETestCaseDocumentData | null>(null)
  let loadAbortController: AbortController | null = null
  const dirty = computed(
    () =>
      Boolean(savedTestCase.value && draft.value) &&
      JSON.stringify(savedTestCase.value) !== JSON.stringify(draft.value),
  )
  const saveIssues = computed(() =>
    draft.value ? getDraftSaveIssues(draft.value) : [],
  )
  const generationIssues = computed(() =>
    draft.value ? getDraftGenerationIssues(draft.value) : [],
  )
  const generationErrors = computed(() =>
    draft.value
      ? issuesToFieldErrors(generationIssues.value)
      : { testCase: '用例尚未加载。' },
  )
  /**
   * 当前草稿是否满足生成条件。
   *
   * **不包含 `!dirty`**：生成入口自带「保存并生成」语义，草稿未保存正是它
   * 需要先执行的动作，不是阻塞条件。若把 dirty 混入本判定，生成入口会在
   * 用户编辑后（必然 dirty）被整体拒绝，表现为点击按钮毫无反应。
   * 是否「此刻可点击」由 `useE2ETestCaseReadiness` 的 generate 动作独立判断。
   */
  const canGenerate = computed(
    () =>
      status.value === 'ready' &&
      Object.keys(generationErrors.value).length === 0,
  )

  /**
   * 将保存阶段校验问题写入行内字段错误，用于就绪摘要导航。
   * @returns 当前草稿是否满足保存条件。
   * @throws 不抛出异常。
   */
  function showSaveValidation(): boolean {
    fieldErrors.value = issuesToFieldErrors(saveIssues.value)
    return saveIssues.value.length === 0
  }

  /**
   * 将生成阶段校验问题写入行内字段错误，用于就绪摘要导航。
   * @returns 当前草稿是否满足生成条件。
   * @throws 不抛出异常。
   */
  function showGenerationValidation(): boolean {
    fieldErrors.value = issuesToFieldErrors(generationIssues.value)
    return generationIssues.value.length === 0
  }

  /** 加载服务端标准化用例，并创建与快照隔离的编辑草稿。 */
  async function load(): Promise<boolean> {
    loadAbortController?.abort()
    const controller = new AbortController()
    loadAbortController = controller
    status.value = 'loading'
    errorMessage.value = ''
    loadErrorCode.value = undefined
    conflictDocument.value = null

    try {
      const response = await fetchE2ETestCase(skillId.value, controller.signal)

      if (controller.signal.aborted) {
        return false
      }

      applyDocument(response.data)
      status.value = 'ready'
      return true
    } catch (error) {
      if (error instanceof ApiClientError && error.kind === 'aborted') {
        return false
      }

      errorMessage.value =
        error instanceof Error ? error.message : '加载 E2E 用例失败。'
      loadErrorCode.value =
        error instanceof ApiClientError ? error.code : undefined
      status.value =
        error instanceof ApiClientError &&
        ['E2E_SCHEMA_INVALID', 'E2E_SCHEMA_VERSION_UNSUPPORTED'].includes(
          error.code ?? '',
        )
          ? 'invalid'
          : 'error'
      return false
    } finally {
      if (loadAbortController === controller) {
        loadAbortController = null
      }
    }
  }

  /** 校验并保存当前草稿；冲突时额外读取磁盘版本但始终保留本地草稿。 */
  async function save(): Promise<boolean> {
    if (!draft.value || !version.value || status.value === 'saving') {
      return false
    }

    showSaveValidation()

    if (saveIssues.value.length > 0) {
      status.value = 'ready'
      message.error('请先修复用例中的校验错误。')
      return false
    }

    status.value = 'saving'

    try {
      const response = await updateE2ETestCase(skillId.value, {
        testCase: draft.value,
        expectedVersion: version.value,
      })
      applyDocument(response.data)
      callbacks.onSaved?.({
        title: response.data.title,
        description: response.data.description,
        version: response.data.version,
        generationReady:
          getDraftGenerationIssues(response.data.testCase).length === 0,
      })
      status.value = 'ready'
      message.success('E2E 用例已保存。')
      return true
    } catch (error) {
      if (
        error instanceof ApiClientError &&
        error.code === 'FILE_VERSION_CONFLICT'
      ) {
        status.value = 'conflicted'
        await loadConflictDocument()
      } else {
        status.value = 'error'
      }

      errorMessage.value =
        error instanceof Error ? error.message : '保存 E2E 用例失败。'
      message.error(errorMessage.value)
      return false
    }
  }

  /**
   * 在保留当前草稿的前提下退出可恢复错误状态，允许用户修正后重试。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function resumeEditing(): void {
    if (draft.value && status.value === 'error') {
      status.value = 'ready'
    }
  }

  function markSourceMissing(): void {
    status.value = 'missing'
    errorMessage.value =
      'e2e_schema.json 已被外部删除；当前草稿仅保留在页面中。'
  }

  function discard(): void {
    if (!savedTestCase.value) {
      return
    }

    draft.value = cloneTestCaseDraft(savedTestCase.value)
    fieldErrors.value = {}
    conflictDocument.value = null
    status.value = 'ready'
  }

  function useDiskVersion(): void {
    if (!conflictDocument.value) {
      return
    }

    applyDocument(conflictDocument.value)
    conflictDocument.value = null
    status.value = 'ready'
  }

  function applyDocument(document: IE2ETestCaseDocumentData): void {
    savedTestCase.value = cloneTestCaseDraft(document.testCase)
    draft.value = cloneTestCaseDraft(document.testCase)
    version.value = document.version
    sourceHash.value = document.sourceHash
    script.value = document.script
    skillDocument.value = document.skillDocument ?? null
    fieldErrors.value = {}
  }

  async function loadConflictDocument(): Promise<void> {
    try {
      const response = await fetchE2ETestCase(skillId.value)
      conflictDocument.value = response.data
    } catch {
      conflictDocument.value = null
    }
  }

  onBeforeUnmount(() => loadAbortController?.abort())
  return {
    savedTestCase,
    draft,
    version,
    sourceHash,
    script,
    skillDocument,
    status,
    errorMessage,
    loadErrorCode,
    fieldErrors,
    conflictDocument,
    dirty,
    saveIssues,
    generationIssues,
    generationErrors,
    canGenerate,
    showSaveValidation,
    showGenerationValidation,
    load,
    resumeEditing,
    save,
    markSourceMissing,
    discard,
    useDiskVersion,
  }
}
