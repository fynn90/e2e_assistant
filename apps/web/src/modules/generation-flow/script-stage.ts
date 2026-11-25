/**
 * Playwright 脚本阶段状态机（由 `usePlaywrightGeneration` 迁移）。
 *
 * v9 的核心变化：**取消「候选 → 用户确认」两步**。`complete` 事件到达后
 * 立即以 `mode: 'generation'` 写入**正式** `test.spec.ts`（严格校验 + 格式化），
 * 成功即产出脚本卡片，失败则产出终止卡片（PRD 8.2 / AC-08）。
 *
 * `temp/` 的定位不变：它仍是 Agent 的工作区，与正式产物之间没有提升关系。
 */
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import type {
  IFileSaveDiagnostic,
  IGeneratePlaywrightData,
  IE2ETestCase,
  IPlaywrightScriptState,
} from '@authine-e2e-agent/types'
import { ApiClientError } from '../../services/http-client'
import { fetchSkillFile } from '../../services/skill-api'
import {
  useAgentWorkTimeline,
  type IUseAgentWorkTimeline,
} from '../agent-work/timeline'
import {
  savePlaywrightScript,
  streamPlaywrightGeneration,
} from '../e2e-test-case/services/e2e-test-case-api'
import type { TStageStatus } from './types'

export interface IScriptStageOptions {
  skillId: Ref<string>
  draft: Ref<IE2ETestCase | null>
  version: Ref<string>
  sourceHash: Ref<string>
  script: Ref<IPlaywrightScriptState | null>
  dirty: Ref<boolean>
  canGenerate: Ref<boolean>
  /** 保存结构化用例（生成前的前置动作）。 */
  saveTestCase: () => Promise<boolean>
  /** 即时保存成功后的回调（刷新文件树与页头脚本状态）。 */
  onScriptSaved?: () => Promise<void> | void
}

/**
 * Playwright 脚本阶段状态机。
 *
 * @param options - Skill、用例版本、脚本状态与保存动作。
 * @returns 只读状态、产出的卡片数据与用户操作方法。
 * @throws 不向调用方抛出：网络与服务端错误由阶段状态吸收。
 */
export function createScriptStage(options: IScriptStageOptions) {
  const status = ref<TStageStatus>('idle')
  /** 生成结果；保存成功后作为脚本卡片的数据来源。 */
  const result = shallowRef<IGeneratePlaywrightData | null>(null)
  /** 磁盘上已有的脚本内容，用于生成卡片中的差异对比。 */
  const existingCode = ref('')
  /** 脚本卡片的可编辑代码（本地 ref，输入与保存解耦）。 */
  const code = ref('')
  const errorMessage = ref('')
  /** 本次生成对应的 Agent 会话 ID：来自 SSE start 事件。 */
  const sessionId = ref<string | null>(null)
  /**
   * 首次落盘时服务端回传的校验诊断。
   *
   * v15：内容质量问题不再阻断落盘，改为诊断呈现——用户在产物卡片上看到「校验提示」。
   * 放在阶段实例而不是实时保存链路上：后者在用户开始编辑后才接管，
   * 而首次落盘的诊断必须在卡片一出现时就可见。
   */
  const diagnostics = ref<readonly IFileSaveDiagnostic[]>([])
  let abortController: AbortController | null = null

  // 独立的可复用时间线实例：与 SKILL 阶段的时间线并存互不干扰（技术方案 6.4）。
  // 单例 store 的 sessionId 是单值，第二个阶段开始时会清空第一个阶段的时间线。
  const timeline: IUseAgentWorkTimeline = useAgentWorkTimeline({
    sessionId,
    onError: (error) => {
      console.warn('[script-stage] 恢复 Agent 工作记录失败：', error)
    },
  })

  const running = ref(false)
  const cancelable = ref(false)

  /** 同步运行中与可取消派生状态。 */
  function syncDerivedState(): void {
    running.value = ![
      'idle',
      'completed',
      'conflict',
      'failed',
      'cancelled',
    ].includes(status.value)
    // 准备、页面核对、生成、校验四个阶段都可能卡在浏览器或模型上，必须可取消（PRD 10.2）。
    cancelable.value = [
      'preparing',
      'verifying-page',
      'generating-script',
      'validating-code',
    ].includes(status.value)
  }

  /**
   * 启动脚本生成并即时保存到正式文件。
   *
   * 顺序：保存用例（如有未落盘改动）→ 就绪校验 → 读取既有脚本供差异对比 →
   * 启动 SSE → complete 事件后立即以 generation 模式写入 `test.spec.ts`。
   *
   * @returns 阶段是否成功完成（含落盘）。
   */
  async function start(): Promise<boolean> {
    if (running.value) return false

    errorMessage.value = ''
    result.value = null
    code.value = ''
    diagnostics.value = []
    status.value = 'idle'
    syncDerivedState()

    if (options.dirty.value) {
      status.value = 'saving-source'
      syncDerivedState()
      const saved = await options.saveTestCase()

      if (!saved) {
        status.value = 'failed'
        errorMessage.value =
          '结构化用例未保存，未开始生成脚本。请按页面提示修复错误或重试保存。'
        syncDerivedState()
        return false
      }
    }

    if (!options.canGenerate.value) {
      status.value = 'failed'
      errorMessage.value = '当前用例尚未满足生成条件。'
      syncDerivedState()
      return false
    }

    abortController?.abort()
    const controller = new AbortController()
    abortController = controller
    // 初始阶段为「准备生成」：服务端在建立 SSE 流前会完成 Chromium 检查。
    status.value = 'preparing'
    syncDerivedState()

    try {
      await loadExistingCode()
      let streamError = ''

      await streamPlaywrightGeneration({
        skillId: options.skillId.value,
        signal: controller.signal,
        request: {
          expectedTestCaseFileVersion: options.version.value,
          expectedScriptVersion: options.script.value?.version ?? null,
        },
        onEvent(event) {
          if (abortController !== controller || controller.signal.aborted)
            return

          if (event.type === 'start') {
            // 记录会话 ID 触发工作事件流订阅：侧边栏据此展示 Agent 工作内容。
            sessionId.value = event.sessionId
          } else if (event.type === 'progress' && event.stage !== 'completed') {
            status.value = event.stage
            syncDerivedState()
          } else if (event.type === 'complete') {
            result.value = event.data
            code.value = event.data.code
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
        errorMessage.value = '生成流结束但没有返回脚本。'
        status.value = 'failed'
        syncDerivedState()
        return false
      }

      // 即时保存：生成完成即写入正式 test.spec.ts（PRD 8.2 / AC-08）。
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
          error instanceof Error ? error.message : 'Playwright 脚本生成失败。'
      }
      syncDerivedState()
      return false
    } finally {
      if (abortController === controller) abortController = null
    }
  }

  /**
   * 以 generation 模式写入正式 `test.spec.ts`。
   *
   * 严格校验 + 写入格式化后的代码；失败时产出终止卡片，
   * 文案需说明磁盘上可能仍是旧版本（PRD 10.3）。
   *
   * @returns 落盘成功时返回 true。
   */
  async function save(): Promise<boolean> {
    if (!result.value || status.value === 'saving-script') return false

    status.value = 'saving-script'
    syncDerivedState()

    try {
      const response = await savePlaywrightScript(options.skillId.value, {
        code: result.value.code,
        sourceHash: result.value.sourceHash,
        expectedScriptVersion: result.value.scriptVersion,
        // 生成完成首次落盘（PRD 8.2）。
        mode: 'generation',
      })
      diagnostics.value = response.data.diagnostics

      options.script.value = {
        exists: true,
        status: 'current',
        version: response.data.version,
        generatedAt: response.data.generatedAt,
        updatedAt: response.data.updatedAt,
        sourceHash: response.data.sourceHash,
      }
      existingCode.value = result.value.code
      status.value = 'completed'
      syncDerivedState()
      await options.onScriptSaved?.()
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
            ? '结构化用例已发生变化，请重新生成脚本。'
            : '磁盘中的 test.spec.ts 已发生变化，请重新生成。'
      } else {
        status.value = 'failed'
        errorMessage.value =
          error instanceof Error ? error.message : '保存 Playwright 脚本失败。'
      }
      syncDerivedState()
      return false
    }
  }

  /** 读取磁盘上已有的脚本，供卡片中的差异对比与重新生成参考。 */
  async function loadExistingCode(): Promise<void> {
    if (!options.script.value?.exists) {
      existingCode.value = ''
      return
    }

    try {
      const response = await fetchSkillFile(
        options.skillId.value,
        'test.spec.ts',
      )
      existingCode.value = response.data.content

      if (options.script.value) {
        options.script.value = {
          ...options.script.value,
          exists: true,
          version: response.data.version,
          updatedAt: response.data.updatedAt,
        }
      }
    } catch {
      // 既有脚本读取失败不影响生成：仅差异对比退化为空。
      existingCode.value = ''
    }
  }

  /** 取消生成（仅可取消阶段生效）。 */
  function cancel(): void {
    if (!cancelable.value) return

    abortController?.abort()
    abortController = null
    status.value = 'cancelled'
    syncDerivedState()
  }

  /** 更新脚本卡片的可编辑代码。 */
  function updateCode(next: string): void {
    code.value = next
  }

  /** 释放阶段占用的资源（store 关闭侧边栏时统一调用）。 */
  function dispose(): void {
    abortController?.abort()
    abortController = null
    timeline.dispose()
  }

  syncDerivedState()

  return {
    kind: 'script' as const,
    title: 'Playwright 脚本阶段',
    /**
     * 本阶段的目标 Skill（v13 需求 3）。
     *
     * 对外暴露它，使实时保存与产物卡片能按**本阶段自己的**目标写入，
     * 而不是去读可能已被别的编辑器覆盖的注入依赖。
     */
    skillId: options.skillId,
    status,
    result,
    existingCode,
    code,
    errorMessage,
    diagnostics,
    sessionId,
    timeline,
    running,
    cancelable,
    start,
    save,
    cancel,
    updateCode,
    dispose,
  }
}

/** 脚本阶段状态机实例类型。 */
export type TScriptStage = ReturnType<typeof createScriptStage>

/** 便于 store 使用的浅引用类型别名。 */
export type TScriptStageRef = ShallowRef<TScriptStage | null>
