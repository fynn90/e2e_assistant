/**
 * SKILL 阶段状态机（由 `useSkillDocumentGeneration` 迁移）。
 *
 * v9 的核心变化：**取消「预览 → 用户确认」两步**。`complete` 事件到达后
 * 立即以 `mode: 'generation'` 落盘（严格校验），成功即产出产物卡片，
 * 失败则产出终止卡片（PRD 8.1 / AC-08）。
 *
 * 状态机与 store 分离，沿用 `agent-work` store 的既有先例——
 * 「归约逻辑抽到独立模块，store 只持有状态」。这样阶段逻辑可独立单测。
 */
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import type {
  IE2ETestCase,
  IFileSaveDiagnostic,
  ISkillDocumentGenerationResult,
  ISkillDocumentState,
} from '@fynn90-e2e_assistant/types'
import { ApiClientError } from '../../services/http-client'
import { abortAgentSession } from '../../services/agent-work-api'
import {
  useAgentWorkTimeline,
  type IUseAgentWorkTimeline,
} from '../agent-work/timeline'
import {
  saveSkillDocument,
  streamSkillDocumentGeneration,
} from '../e2e-test-case/services/skill-document-api'
import type { TStageStatus } from './types'

export interface ISkillStageOptions {
  skillId: Ref<string>
  draft: Ref<IE2ETestCase | null>
  version: Ref<string>
  sourceHash: Ref<string>
  skillDocument: Ref<ISkillDocumentState | null>
  dirty: Ref<boolean>
  canGenerate: Ref<boolean>
  /** 保存结构化用例（生成前的前置动作）。 */
  saveTestCase: () => Promise<boolean>
  /** 即时保存成功后的回调（刷新文件树与元数据）。 */
  onSaved?: () => Promise<void> | void
}

/**
 * SKILL 阶段状态机。
 *
 * @param options - Skill、用例版本、文档状态与保存动作。
 * @returns 只读状态、产出的卡片数据与用户操作方法。
 * @throws 不向调用方抛出：网络与服务端错误由阶段状态吸收。
 */
export function createSkillStage (options: ISkillStageOptions) {
  const status = ref<TStageStatus>('idle')
  /** 生成结果；保存成功后作为产物卡片的数据来源。 */
  const result = shallowRef<ISkillDocumentGenerationResult | null>(null)
  /** 产物卡片的可编辑正文（本地 ref，输入与保存解耦）。 */
  const content = ref('')
  const errorMessage = ref('')
  /** 本次生成对应的 Agent 会话 ID：来自 SSE start 事件。 */
  const sessionId = ref<string | null>(null)
  /**
   * 首次落盘时服务端回传的校验诊断。
   *
   * v15：内容质量问题不再阻断落盘，改为诊断呈现——用户在产物卡片上看到「校验提示」。
   * 放在阶段实例而不是 `attachSkillAutoSave` 的实时保存链路上：后者在用户开始编辑后
   * 才接管，而首次落盘的诊断必须在卡片一出现时就可见。
   */
  const diagnostics = ref<readonly IFileSaveDiagnostic[]>([])
  let abortController: AbortController | null = null

  // 独立的可复用时间线实例：与另一个阶段的时间线并存互不干扰（技术方案 6.4）。
  const timeline: IUseAgentWorkTimeline = useAgentWorkTimeline({
    sessionId,
    onError: (error) => {
      // 工作流是观察通道，历史恢复失败不阻断生成主流程，仅记录以便排查装配问题。
      console.warn('[skill-stage] 恢复 Agent 工作记录失败：', error)
    },
  })

  const running = ref(false)
  const cancelable = ref(false)

  /** 同步运行中与可取消派生状态。 */
  function syncDerivedState (): void {
    running.value = ![
      'idle',
      'completed',
      'conflict',
      'failed',
      'cancelled',
    ].includes(status.value)
    // 保存用例与即时保存落盘属于不可取消阶段（PRD 10.2）。
    cancelable.value = [
      'requesting-model',
      'writing-skill',
      'repairing-output',
      'validating-output',
    ].includes(status.value)
  }

  /**
   * 启动 SKILL 生成并即时保存。
   *
   * 顺序：保存用例（如有未落盘改动）→ 就绪校验 → 启动 SSE →
   * complete 事件后立即以 generation 模式落盘。
   *
   * @returns 阶段是否成功完成（含落盘）。
   */
  async function start (): Promise<boolean> {
    if (running.value) return false

    errorMessage.value = ''
    result.value = null
    content.value = ''
    diagnostics.value = []
    sessionId.value = null
    status.value = 'idle'
    syncDerivedState()

    if (options.dirty.value) {
      status.value = 'saving-source'
      syncDerivedState()
      if (!(await options.saveTestCase())) {
        status.value = 'failed'
        errorMessage.value = '结构化用例未保存，未开始生成 SKILL.md。'
        syncDerivedState()
        return false
      }
    }

    if (!options.canGenerate.value) {
      status.value = 'failed'
      errorMessage.value = '当前用例尚未满足 SKILL.md 生成条件。'
      syncDerivedState()
      return false
    }

    abortController?.abort()
    const controller = new AbortController()
    abortController = controller
    status.value = 'requesting-model'
    syncDerivedState()

    try {
      let streamError = ''

      await streamSkillDocumentGeneration({
        skillId: options.skillId.value,
        signal: controller.signal,
        request: {
          expectedTestCaseFileVersion: options.version.value,
          expectedSkillDocumentVersion:
            options.skillDocument.value?.version ?? null,
        },
        onEvent (event) {
          if (controller.signal.aborted || abortController !== controller)
            return

          if (event.type === 'start') {
            // 记录会话 ID 触发工作事件流订阅（useAgentWorkTimeline 的 watch）。
            sessionId.value = event.sessionId
          } else if (event.type === 'progress') {
            status.value =
              event.stage === 'completed' ? 'validating-output' : event.stage
            syncDerivedState()
          } else if (event.type === 'complete') {
            result.value = event.data
            content.value = event.data.content
          } else if (event.type === 'error') {
            streamError = event.message
          }
        },
      })

      if (controller.signal.aborted) {
        status.value = 'cancelled'
        syncDerivedState()
        return false
      }

      if (streamError) {
        errorMessage.value = streamError
        status.value = 'failed'
        syncDerivedState()
        return false
      }

      if (!result.value) {
        errorMessage.value = '生成流结束但没有返回 SKILL.md。'
        status.value = 'failed'
        syncDerivedState()
        return false
      }

      // 即时保存：生成完成即落盘，无需用户确认（PRD 8.1 / AC-08）。
      return await save()
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof ApiClientError && error.kind === 'aborted')
      ) {
        status.value = 'cancelled'
      } else {
        status.value = 'failed'
        errorMessage.value =
          error instanceof Error ? error.message : 'SKILL.md 生成失败。'
      }
      syncDerivedState()
      return false
    } finally {
      if (abortController === controller) abortController = null
    }
  }

  /**
   * 以 generation 模式落盘 SKILL.md。
   *
   * v15：内容质量问题不再阻断，转由 `diagnostics` 呈现给用户；只有安全族问题
   * （明文凭据）仍以失败告终。
   *
   * @returns 落盘成功时返回 true。
   */
  async function save (): Promise<boolean> {
    if (!result.value || status.value === 'saving-skill') return false

    status.value = 'saving-skill'
    syncDerivedState()

    try {
      const response = await saveSkillDocument(options.skillId.value, {
        content: content.value,
        sourceHash: result.value.sourceHash,
        expectedSkillDocumentVersion: result.value.skillDocumentVersion,
        // 生成完成首次落盘（PRD 8.1）。
        mode: 'generation',
      })
      diagnostics.value = response.data.diagnostics
      status.value = 'completed'
      syncDerivedState()
      await options.onSaved?.()
      return true
    } catch (error) {
      const conflictCode =
        error instanceof ApiClientError &&
          ['FILE_VERSION_CONFLICT', 'SOURCE_HASH_CONFLICT'].includes(
            error.code ?? '',
          )
          ? error.code
          : null

      if (conflictCode) {
        status.value = 'conflict'
        errorMessage.value =
          conflictCode === 'SOURCE_HASH_CONFLICT'
            ? '结构化用例已变化，请重新生成 SKILL.md。'
            : 'SKILL.md 已被外部修改，请重新生成。'
      } else {
        status.value = 'failed'
        errorMessage.value =
          error instanceof Error ? error.message : '保存 SKILL.md 失败。'
      }
      syncDerivedState()
      return false
    }
  }

  /**
   * 取消生成。
   *
   * 主路径是中止浏览器 fetch（服务端感知请求断开后终止运行轮次）；
   * 额外调用显式中止端点，避免 SSE 断开与运行轮次存活之间的时序脱节。
   */
  function cancel (): void {
    if (!cancelable.value) return

    const activeSessionId = sessionId.value
    if (activeSessionId) {
      void abortAgentSession(activeSessionId).catch(() => undefined)
    }
    abortController?.abort()
    abortController = null
    status.value = 'cancelled'
    syncDerivedState()
  }

  /** 更新产物卡片的可编辑正文。 */
  function updateContent (next: string): void {
    content.value = next
  }

  /** 释放时间线实例（store 关闭侧边栏时统一调用）。 */
  function dispose (): void {
    abortController?.abort()
    abortController = null
    timeline.dispose()
  }

  syncDerivedState()

  return {
    kind: 'skill' as const,
    title: 'SKILL 阶段',
    status,
    result,
    content,
    errorMessage,
    diagnostics,
    sessionId,
    timeline,
    running,
    cancelable,
    start,
    save,
    cancel,
    updateContent,
    dispose,
  }
}

/** SKILL 阶段状态机实例类型。 */
export type TSkillStage = ReturnType<typeof createSkillStage>

/** 便于 store 使用的浅引用类型别名。 */
export type TSkillStageRef = ShallowRef<TSkillStage | null>
