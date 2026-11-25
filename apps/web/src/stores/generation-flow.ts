/**
 * 生成流程 store：持有两个阶段实例、产物卡片的实时保存编排与侧边栏内容模型。
 *
 * 为什么上收为 store：侧边栏在 `SkillDevPage` 渲染，而生成入口由
 * `E2ETestCaseEditor` 触发，两者是**兄弟组件**。通过 provide/inject 传递
 * 两个状态机会让层级耦合变重，且页面需要知道子组件的内部结构。
 * store 是既有的跨组件共享手段（`agent-work`、`global-chat` 均为 store）。
 *
 * 为什么状态机仍是独立模块：沿用 `agent-work` store 的既有先例——
 * store 只持有状态与编排，阶段逻辑放在 `modules/generation-flow/*-stage.ts`，
 * 保证可测试性与单一职责。
 *
 * 为什么保存编排也在此：产物卡片的 `useAutoSave` 实例必须能被
 * `close()` 统一 flush（PRD 7.6）并判断是否存在未解决的保存失败（PRD 6.6）。
 * 放在卡片组件内会让关闭流程无法访问它们。
 *
 * 非持久化（PRD 第 12 章）：卡片、时间线、折叠状态**仅在内存中**，
 * 不接入任何持久化插件，不写 localStorage。刷新后 store 重置回空态。
 */
import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  IFileSaveDiagnostic,
  IGeneratePlaywrightData,
  ISkillDocumentGenerationResult,
} from '@charlie_deng/e2e-assistant-types'
import { useGlobalChatStore, type IWorkbenchSubject } from './global-chat'
import { useAutoSave, type IUseAutoSave } from '../common/autosave/useAutoSave'
import {
  createPlaywrightScriptTarget,
  createSkillDocumentTarget,
} from '../common/autosave/save-targets'
import type { TAutoSaveState } from '../common/autosave/types'
import {
  createSkillStage,
  type ISkillStageOptions,
  type TSkillStage,
} from '../modules/generation-flow/skill-stage'
import {
  createScriptStage,
  type IScriptStageOptions,
  type TScriptStage,
} from '../modules/generation-flow/script-stage'
import {
  resolveScriptContext,
  type IScriptContextResolution,
} from '../modules/generation-flow/script-context'
import {
  createCardKey,
  createFailureCardKey,
  deriveFlowPhaseFromStages,
  deriveLatestCardKey,
  derivePrimaryAction,
  toSidebarItems,
} from '../modules/generation-flow/card-model'
import {
  deriveSubtitle,
  STAGE_TEXT_TABLE,
} from '../modules/generation-flow/status-text'
import {
  isStageRunning,
  isTerminalStatus,
  type IFailureCard,
  type IProductCard,
  type IStageRecord,
  type TFlowPhase,
  type TSidebarItem,
} from '../modules/generation-flow/types'

/** 阶段状态机实例持有的可替换依赖（由持有用例草稿的组件注入）。 */
export interface IGenerationFlowDependencies {
  skill: ISkillStageOptions
  script: IScriptStageOptions
}

/**
 * 阶段终态通知的接收器（v13 PRD N 组）。
 *
 * 形状与 `IPublishNoticeInput` 一致，但在此独立声明以避免 store 反向依赖
 * composable 层——store 只声明「我需要一个这样的出口」，由外壳决定接到哪。
 */
export interface ITerminalNoticeSink {
  (input: {
    subject: IWorkbenchSubject | null
    kind: 'success' | 'warning' | 'error'
    notice: { title: string; description?: string }
    dedupeKey: string
  }): void
}

/** 当前用例来源哈希（两个阶段共用；保存产物时服务端据此拒绝陈旧内容）。 */
let sourceHash = ''

export const useGenerationFlowStore = defineStore('generation-flow', () => {
  const globalChat = useGlobalChatStore()

  /** 阶段序列，按发生顺序：skill → script。 */
  const stages = shallowRef<IStageRecord[]>([])
  /** 阶段状态机实例（非响应式持有，避免深层代理包裹时间线内部状态）。 */
  const skillStage = shallowRef<TSkillStage | null>(null)
  const scriptStage = shallowRef<TScriptStage | null>(null)
  /** 产物卡片的实时保存实例，按卡片 key 索引。 */
  const autoSaves = new Map<string, IUseAutoSave>()
  /** 可替换依赖：由 E2ETestCaseEditor 在挂载时注入。 */
  let dependencies: IGenerationFlowDependencies | null = null
  /**
   * 已派发过终态通知的阶段键（`kind:status`）。
   *
   * `syncStageRecord` 会被多次调用（watch + 显式同步），没有它就会重复通知。
   * 在 `reset()` 时清空——新一轮生成是新的工作项。
   */
  const notifiedTerminals = new Set<string>()
  /**
   * 阶段终态通知的出口（由应用外壳注入，见 `setTerminalNoticeSink`）。
   *
   * 用模块级变量而非 state：它是跨组件的编排依赖，不是渲染数据，
   * 放进 state 会让 Pinia 对其做响应式代理（无意义的开销与语义噪音）。
   */
  let terminalNoticeSink: ITerminalNoticeSink | null = null
  /**
   * 脚本阶段当前使用的来源哈希（v13 需求 3）。
   *
   * 与模块级 `sourceHash`（编辑器注入的那份）分开：工作台可以在编辑器已指向
   * 另一个 Skill 的情况下为一个 Skill 生成脚本，此时必须用**该 Skill** 的哈希，
   * 否则服务端会以哈希不符拒绝保存。
   */
  let scriptSourceHash = ''

  /** 流程整体阶段。 */
  const phase = computed<TFlowPhase>(() =>
    deriveFlowPhaseFromStages(stages.value),
  )
  /** 标题栏副标题（PRD 5.2 文案表）。 */
  const subtitle = computed(() => deriveSubtitle(phase.value))
  /** 是否存在运行中的阶段（决定关闭按钮显隐，PRD 6.6）。 */
  const isRunning = computed(() =>
    stages.value.some((stage) => isStageRunning(stage)),
  )
  /** 当前「最新卡片」的标识（唯一承载关闭按钮的卡片，PRD 6.6）。 */
  const latestCardKey = computed(() => deriveLatestCardKey(stages.value))
  /** 侧边栏内容项：阶段区块与卡片平级排列（PRD 5.4）。 */
  const sidebarItems = computed<TSidebarItem[]>(() =>
    toSidebarItems(stages.value),
  )
  /** 是否存在流程数据（空态判定，PRD 5.5）。 */
  const hasFlowData = computed(() => stages.value.length > 0)
  /** 是否存在未解决的保存失败（决定关闭前是否二次确认，PRD 6.6 唯一例外）。 */
  const hasUnsavedFailure = computed(() =>
    [...autoSaves.values()].some(
      (autoSave) =>
        autoSave.state.value === 'failed' ||
        autoSave.state.value === 'conflict',
    ),
  )

  /**
   * 注入阶段状态机所需的业务依赖。
   *
   * 由 `E2ETestCaseEditor` 在挂载时调用——只有它持有用例草稿、版本与保存动作。
   *
   * @param next - 两个阶段的依赖集合。
   * @param currentSourceHash - 当前用例来源哈希。
   */
  function setDependencies (
    next: IGenerationFlowDependencies,
    currentSourceHash: string,
  ): void {
    dependencies = next
    sourceHash = currentSourceHash
  }

  /**
   * 刷新用例来源哈希（用例保存后由调用方更新）。
   *
   * @param next - 最新来源哈希。
   */
  function setSourceHash (next: string): void {
    sourceHash = next
  }

  /**
   * 注入阶段终态通知的出口（v13 PRD N 组）。
   *
   * 由应用外壳注入，而不是由 store 直接调用 notification：store 不应该
   * 依赖任何 UI 组件族（保持可单测）；且通知的「工作台是否展开」判定
   * 与去重逻辑统一收敛在发布器里（技术方案 §3.9.3）。
   *
   * @param sink - 通知接收器；传 null 表示不再通知（外壳卸载）。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function setTerminalNoticeSink (sink: ITerminalNoticeSink | null): void {
    terminalNoticeSink = sink
  }

  /**
   * 启动 SKILL 阶段。
   *
   * 就绪校验失败时**不展开侧边栏**、不创建阶段记录，直接返回 false，
   * 由调用方展示页内就绪摘要（PRD 4.4 规则 3 / AC-15）。
   *
   * @returns 阶段是否成功完成（含即时保存）。
   */
  async function startSkillGeneration (): Promise<boolean> {
    if (!dependencies) return false

    // 就绪校验：失败时**不展开侧边栏**、不创建阶段记录，
    // 由调用方展示页内就绪摘要，保持既有行为不变（PRD 4.4 规则 3 / AC-15）。
    //
    // 判据只包含「即便先保存也无法生成」的硬性阻塞（模型未配置、用例结构不
    // 满足生成条件等）；**不包含草稿是否 dirty**——保存用例正是本入口要执行
    // 的第一步动作，把它算作阻塞会让用户在编辑后点不动按钮。
    if (!dependencies.skill.canGenerate.value) return false

    // 新一轮生成总是从干净的工作台开始（v9 PRD 4.4 规则 2、v13 PRD C-2）。
    //
    // 只 `reset()` 而**不** `close()`：close 会连带收起工作台，而下一行就要展开，
    // 两次相反的界面动作互相抵消，读代码的人却要推理才会发现。
    if (stages.value.length > 0 && !isRunning.value) reset()

    // 立即展开工作台，不等 sessionId 到达（v9 PRD 4.4 规则 1）。
    globalChat.expand()

    // 落地显示主体（v13 PRD C-2/C-4）。
    //
    // **时机**：必须在 `canGenerate` 守卫之后、`stage.start()` 之前。
    //   - 放在守卫之后 → 就绪不通过时不落地，满足 C-4「未启动不清空」；
    //   - 放在 start 之前 → 生成可能持续数十秒，期间工作台必须已经指向新工作项，
    //     否则会继续显示上一个工作项的内容（v13 的显示主体按 subject 分派）。
    // 放在本 store 而不是调用方：清空与落地是同一件事的两面，拆到两处必然分叉
    // ——初版就曾在 await 之后清空，把刚创建、正在运行的阶段实例一并销毁。
    globalChat.setSubject({
      kind: 'generation',
      skillId: dependencies.skill.skillId.value,
    })

    const stage = createSkillStage(dependencies.skill)
    skillStage.value = stage

    upsertStage(stage)
    watch([stage.status, stage.errorMessage], () => syncStageRecord(stage))

    const completed = await stage.start()
    syncStageRecord(stage)
    if (completed) attachSkillAutoSave(stage)
    return completed
  }

  /**
   * 启动脚本阶段（由 SKILL.md 卡片的主按钮触发）。
   *
   * **目标 Skill 的确定方式**（v13 需求 3）：以**工作台显示主体记录的 Skill**
   * 为准，而不是注入依赖里的那个。原因：依赖槽位是模块级单例，后挂载的编辑器
   * 会覆盖它——工作台正在展示 Skill A 时用户若进过 Skill B 的开发页，
   * 槽位已指向 B，按槽位生成就会**给错误的 Skill 写脚本**。
   *
   * 离开 Skill 开发页后仍可调用：槽位不指向目标时自动从服务端重读该 Skill 的
   * 用例与脚本状态（见 `resolveScriptContext`），因此工作台不依赖编辑器是否还在。
   *
   * @returns 阶段是否成功完成（含即时保存）。
   * @throws 不抛出异常；解析上下文失败时以失败阶段呈现。
   */
  async function startScriptGeneration (): Promise<boolean> {
    if (isRunning.value) return false

    // 目标 Skill：优先显示主体；主体不是生成（异常路径）时退回注入依赖。
    const targetSkillId =
      globalChat.subject?.kind === 'generation'
        ? globalChat.subject.skillId
        : dependencies?.script.skillId.value
    if (!targetSkillId) return false

    globalChat.setSubject({ kind: 'generation', skillId: targetSkillId })
    globalChat.expand()

    let resolution: IScriptContextResolution
    try {
      resolution = await resolveScriptContext({
        skillId: targetSkillId,
        injected: dependencies?.script ?? null,
        injectedSourceHash: sourceHash,
      })
    } catch (error) {
      // 读不到用例就谈不上生成：以失败阶段呈现，让用户在工作台看到原因
      // （而不是按钮点了没反应）。
      const failedStage = createScriptStage(
        unavailableScriptOptions(targetSkillId),
      )
      scriptStage.value = failedStage
      upsertStage(failedStage)
      failedStage.status.value = 'failed'
      failedStage.errorMessage.value =
        error instanceof Error ? error.message : '无法读取该 Skill 的用例。'
      syncStageRecord(failedStage)
      return false
    }

    const stage = createScriptStage(resolution.options)
    scriptStage.value = stage
    // 实时保存与卡片保存都要用**该 Skill** 的来源哈希，不能用槽位里那份
    // （它可能属于另一个 Skill，服务端会以哈希不符拒绝保存）。
    scriptSourceHash = resolution.sourceHash
    upsertStage(stage)
    watch([stage.status, stage.errorMessage], () => syncStageRecord(stage))

    const completed = await stage.start()
    syncStageRecord(stage)
    if (completed) attachScriptAutoSave(stage)
    return completed
  }

  /**
   * 为 SKILL.md 卡片挂载实时保存实例。
   *
   * 保存目标固定为 `PUT /skill-document` 且 `mode: 'edit'`——
   * 首次落盘已由阶段状态机以 generation 模式完成（PRD 8.1）。
   *
   * @param stage - 已完成的 SKILL 阶段实例。
   */
  function attachSkillAutoSave (stage: TSkillStage): void {
    const record = stages.value.find((item) => item.kind === 'skill')
    if (!record?.card) return

    const cardKey = record.card.key
    const cardVersion = stage.result.value?.skillDocumentVersion ?? ''

    const autoSave = useAutoSave({
      getContent: () => stage.content.value,
      target: computed(() =>
        createSkillDocumentTarget(
          dependencies!.skill.skillId.value,
          sourceHash,
          cardVersion,
        ),
      ),
      onSaved: (result) => {
        updateCardSaveState(cardKey, result.diagnostics)
      },
      // 跨页面存活：本实例由 store 持有，释放时机由 reset() 统一控制（v13 PRD R-6）。
      autoDispose: false,
    })

    autoSaves.set(cardKey, autoSave)
    watch([autoSave.state, autoSave.diagnostics], () =>
      updateCardSaveState(cardKey, autoSave.diagnostics.value),
    )
  }

  /**
   * 为脚本卡片挂载实时保存实例。
   *
   * 保存目标固定为 `PUT /playwright-script` 且 `mode: 'edit'`——
   * edit 模式服务端**不做格式化**，否则每次防抖保存都会重排用户正在编辑的代码。
   *
   * @param stage - 已完成的脚本阶段实例。
   */
  function attachScriptAutoSave (stage: TScriptStage): void {
    const record = stages.value.find((item) => item.kind === 'script')
    if (!record?.card) return

    const cardKey = record.card.key
    const cardVersion = stage.result.value?.scriptVersion ?? null

    const autoSave = useAutoSave({
      getContent: () => stage.code.value,
      target: computed(() =>
        createPlaywrightScriptTarget(
          // 卡片自己的 Skill 与来源哈希（v13 需求 3）：不能用 `dependencies`
          // 或模块级 `sourceHash`——它们可能属于另一个 Skill。
          scriptStage.value?.skillId.value ?? '',
          scriptSourceHash,
          cardVersion,
        ),
      ),
      onSaved: (result) => {
        updateCardSaveState(cardKey, result.diagnostics)
      },
      // 同 SKILL.md 卡片：由 store 统一释放（v13 PRD R-6）。
      autoDispose: false,
    })

    autoSaves.set(cardKey, autoSave)
    watch([autoSave.state, autoSave.diagnostics], () =>
      updateCardSaveState(cardKey, autoSave.diagnostics.value),
    )
  }

  /**
   * 把实时保存状态同步到卡片模型（卡片头徽标与错误条的数据源）。
   *
   * @param cardKey - 卡片唯一标识。
   * @param diagnostics - 最近一次校验诊断。
   */
  function updateCardSaveState (
    cardKey: string,
    diagnostics: readonly IFileSaveDiagnostic[] = [],
  ): void {
    const autoSave = autoSaves.get(cardKey)
    if (!autoSave) return

    stages.value = stages.value.map((stage) =>
      stage.card?.key === cardKey
        ? {
          ...stage,
          card: {
            ...stage.card,
            saveState: autoSave.state.value,
            diagnostics,
          },
        }
        : stage,
    )
  }

  /**
   * 标记卡片内容已变化（编辑器的输入事件同步调用）。
   *
   * **同步返回、不 await 任何 Promise**：编辑器绑定本地 ref，
   * 输入上屏与保存完全解耦（PRD 7.3「输入永不阻塞」）。
   *
   * @param cardKey - 卡片唯一标识。
   * @param content - 最新内容。
   */
  function updateCardContent (cardKey: string, content: string): void {
    const record = stages.value.find((stage) => stage.card?.key === cardKey)
    if (!record?.card) return

    // 同步回阶段实例，使实时保存的 getContent 读到最新内容。
    if (record.kind === 'skill') skillStage.value?.updateContent(content)
    else scriptStage.value?.updateCode(content)

    stages.value = stages.value.map((stage) =>
      stage.card?.key === cardKey
        ? { ...stage, card: { ...stage.card!, content } }
        : stage,
    )

    autoSaves.get(cardKey)?.markDirty()
  }

  /**
   * 切换产物卡片的视图模式（预览 / 源码）。
   *
   * @param cardKey - 卡片唯一标识。
   * @param viewMode - 目标视图模式。
   */
  function setCardViewMode (
    cardKey: string,
    viewMode: 'preview' | 'source',
  ): void {
    stages.value = stages.value.map((stage) =>
      stage.card?.key === cardKey
        ? { ...stage, card: { ...stage.card, viewMode } }
        : stage,
    )
  }

  /**
   * 把阶段实例的当前状态同步回阶段记录。
   *
   * 阶段实例自身持有响应式状态（供运行中实时更新），阶段记录是渲染快照；
   * 每次状态变化都重新派生卡片模型。
   *
   * @param stage - 待同步的阶段实例。
   */
  function syncStageRecord (stage: TSkillStage | TScriptStage): void {
    const record = stages.value.find((item) => item.kind === stage.kind)
    if (!record) return

    const terminal = isTerminalStatus(stage.status.value)
    // 卡片只在「完成」时产出；已存在的卡片保留其实时保存状态（由 updateCardSaveState 维护）。
    const nextCard = deriveCard(stage) ?? record.card

    stages.value = stages.value.map((item) =>
      item === record
        ? {
          ...item,
          status: stage.status.value,
          stageText: STAGE_TEXT_TABLE[stage.status.value] ?? '',
          cancelable: stage.cancelable.value,
          card: nextCard,
          failureCard: deriveFailureCard(stage),
          settledAt: terminal
            ? (item.settledAt ?? new Date().toISOString())
            : undefined,
        }
        : item,
    )

    // 终态通知在记录同步之后派发，保证调用方读到的 stages 已是终态。
    publishStageTerminalNotice(stage)
  }

  /**
   * 插入阶段记录；同种类阶段已存在时替换（重新生成场景）。
   *
   * @param stage - 新创建的阶段实例。
   */
  function upsertStage (stage: TSkillStage | TScriptStage): void {
    const record: IStageRecord = {
      kind: stage.kind,
      title: stage.title,
      status: stage.status.value,
      timeline: stage.timeline,
      card: null,
      failureCard: null,
      stageText: STAGE_TEXT_TABLE[stage.status.value] ?? '',
      cancelable: stage.cancelable.value,
      startedAt: new Date().toISOString(),
    }
    const existingIndex = stages.value.findIndex(
      (item) => item.kind === stage.kind,
    )
    stages.value =
      existingIndex >= 0
        ? stages.value.map((item, index) =>
          index === existingIndex ? record : item,
        )
        : [...stages.value, record]
  }

  /**
   * 由阶段实例派生产物卡片。
   *
   * 规则（PRD 5.4）：**仅当阶段状态为「完成」时**产出卡片。
   *
   * @param stage - 阶段实例。
   * @returns 产物卡片；未完成时返回 null。
   */
  function deriveCard (stage: TSkillStage | TScriptStage): IProductCard | null {
    if (stage.status.value !== 'completed') return null

    if (stage.kind === 'skill') {
      const result = (stage as TSkillStage).result
        .value as ISkillDocumentGenerationResult | null
      if (!result) return null

      return {
        key: createCardKey('skill-document', result.skillDocumentVersion),
        kind: 'skill-document',
        fileName: 'SKILL.md',
        content: (stage as TSkillStage).content.value,
        viewMode: 'preview',
        completionHint:
          'SKILL.md 已保存到当前 Skill。可直接修改下方源码，改动会实时保存。',
        warnings: result.warnings,
        assumptions: result.assumptions,
        environmentVariables: result.environmentVariables,
        stepCoverage: [],
        meta: {
          testCaseVersion: result.testCaseVersion,
          version: result.skillDocumentVersion,
        },
        saveState: 'saved',
        // v15：首次落盘的校验诊断随卡片呈现（质量问题提示用户，不阻断落盘）。
        diagnostics: (stage as TSkillStage).diagnostics.value,
      }
    }

    const result = (stage as TScriptStage).result
      .value as IGeneratePlaywrightData | null
    if (!result) return null

    return {
      key: createCardKey('playwright-script', result.testCaseVersion),
      kind: 'playwright-script',
      fileName: 'test.spec.ts',
      content: (stage as TScriptStage).code.value,
      viewMode: 'source',
      completionHint:
        'test.spec.ts 已保存到当前 Skill。可直接修改下方代码，改动会实时保存。当前未运行任何测试。',
      warnings: result.warnings,
      assumptions: result.assumptions,
      environmentVariables: result.environmentVariables,
      stepCoverage: result.stepCoverage,
      meta: {
        testCaseVersion: result.testCaseVersion,
        version: result.scriptVersion ?? '',
      },
      saveState: 'saved',
      // v15：首次落盘的校验诊断随卡片呈现（质量问题提示用户，不阻断落盘）。
      diagnostics: (stage as TScriptStage).diagnostics.value,
    }
  }

  /**
   * 派发阶段终态通知（v13 PRD N 组）。
   *
   * 为什么在 `syncStageRecord` 内派发而不是让组件 watch：终态是**阶段记录**
   * 的属性，它每次变化都经这里同步；从这里出去能保证「一次终态一条通知」，
   * 不受调用方在哪个页面、组件是否挂载影响——这正是需求「收起状态下也要提示」
   * 成立的前提。
   *
   * 只派发一次：`syncStageRecord` 会被多次调用（watch + 显式同步），因此以
   * 「阶段 + 终态」为键去重，重复进入终态不重复通知。
   *
   * @param stage - 刚同步的阶段实例。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function publishStageTerminalNotice (stage: TSkillStage | TScriptStage): void {
    const status = stage.status.value
    if (!isTerminalStatus(status)) return

    const fileName = stage.kind === 'skill' ? 'SKILL.md' : 'test.spec.ts'
    const key = `${stage.kind}:${status}`
    if (notifiedTerminals.has(key)) return
    notifiedTerminals.add(key)

    // 三态映射（技术方案 §3.9.4）：失败与冲突都是「用户需要处理的问题」，
    // 归 error；取消是用户自己的动作，归 warning，不呈现为失败。
    const kind: 'success' | 'warning' | 'error' =
      status === 'completed'
        ? 'success'
        : status === 'cancelled'
          ? 'warning'
          : 'error'

    const title =
      status === 'completed'
        ? `${fileName} 生成完成`
        : status === 'cancelled'
          ? `${fileName} 已停止生成`
          : status === 'conflict'
            ? `${fileName} 未能保存：文件已在别处修改`
            : `${fileName} 生成失败`

    terminalNoticeSink?.({
      subject: currentSubject(),
      kind,
      notice: {
        title,
        ...(stage.errorMessage.value && status !== 'completed'
          ? { description: stage.errorMessage.value }
          : {}),
      },
      dedupeKey: `generation:${stage.kind}:${status}`,
    })
  }

  /**
   * 构造生成工作项的显示主体。
   *
   * `dependencies` 尚未注入时（理论上不会发生：终态必然发生在生成启动之后）
   * 返回 null，此时通知发布器会跳过（宁可不提示，也不伪造来源）。
   *
   * @returns 显示主体或 null。
   * @throws 不抛出异常。
   */
  function currentSubject (): IWorkbenchSubject | null {
    const skillId = dependencies?.skill.skillId.value
    if (!skillId) return null
    return { kind: 'generation', skillId }
  }

  /**
   * 由阶段实例派生终止卡片。
   *
   * 规则（PRD 5.4 / 6.5）：失败或取消时出现终止卡片，**不出现**产物卡片。
   *
   * @param stage - 阶段实例。
   * @returns 终止卡片；正常完成或运行中时返回 null。
   */
  function deriveFailureCard (
    stage: TSkillStage | TScriptStage,
  ): IFailureCard | null {
    const status = stage.status.value
    if (status !== 'failed' && status !== 'cancelled' && status !== 'conflict')
      return null

    const failedFileName = stage.kind === 'skill' ? 'SKILL.md' : 'test.spec.ts'
    const cancelled = status === 'cancelled'
    const hasResult =
      stage.kind === 'skill'
        ? (stage as TSkillStage).result.value !== null
        : (stage as TScriptStage).result.value !== null

    return {
      key: createFailureCardKey(stage.kind, cancelled ? 'cancelled' : 'failed'),
      kind: stage.kind,
      fileName: failedFileName,
      status: cancelled ? 'cancelled' : 'failed',
      errorMessage: cancelled
        ? `${failedFileName} 生成已停止。`
        : stage.errorMessage.value,
      // 生成成功但落盘失败时磁盘上可能仍是旧版本——必须说明，避免用户误以为已更新（PRD 10.3）。
      partialWriteHint:
        !cancelled && hasResult
          ? `磁盘上的 ${failedFileName} 可能仍是生成前的旧版本，请检查后再决定是否重新生成。`
          : undefined,
      nextStepHint: '可关闭本侧边栏后重新生成。',
    }
  }

  /** 依赖刷新回调：由调用方注入，用于「重新加载」时同步用例版本。 */
  let dependencyRefresh: (() => Promise<void>) | null = null

  /**
   * 注入「重新加载」时需要同步的数据刷新动作。
   *
   * @param refresh - 刷新动作（重新读取用例版本与来源哈希）。
   */
  function setRefreshHandler (refresh: () => Promise<void>): void {
    dependencyRefresh = refresh
  }

  /**
   * 从磁盘读回固定产物文件内容。
   *
   * @param relativePath - 产物文件相对路径。
   * @returns 文件内容；读取失败时返回 null。
   */
  async function readBackGeneratedFile (
    relativePath: string,
  ): Promise<string | null> {
    try {
      const { fetchSkillFile } = await import('../services/skill-api')
      const response = await fetchSkillFile(
        dependencies!.skill.skillId.value,
        relativePath,
      )
      return response.data.content
    } catch {
      return null
    }
  }

  /**
   * 取消指定阶段的生成（仅可取消阶段生效，PRD 10.2）。
   *
   * @param kind - 阶段种类。
   */
  function cancelStage (kind: 'skill' | 'script'): void {
    const stage = kind === 'skill' ? skillStage.value : scriptStage.value
    stage?.cancel()
    if (stage) syncStageRecord(stage)
  }

  /**
   * 取指定阶段的 Agent 会话 ID（交互卡片回答需要它定位会话）。
   *
   * @param kind - 阶段种类。
   * @returns 会话 ID；阶段未建立会话时返回 null。
   */
  function sessionIdFor (kind: 'skill' | 'script'): string | null {
    return kind === 'skill'
      ? (skillStage.value?.sessionId.value ?? null)
      : (scriptStage.value?.sessionId.value ?? null)
  }

  /**
   * 为指定阶段记录派生主按钮的置灰信息（PRD 6.7）。
   *
   * @param card - 待判定的卡片。
   * @returns 置灰信息；无需置灰时返回 null。
   */
  function primaryActionFor (
    card: IProductCard,
  ): { executedAt: string; label: string } | null {
    return derivePrimaryAction(stages.value, card)
  }

  /**
   * 取脚本卡片差异对比的「原始」侧内容（磁盘上的既有脚本）。
   *
   * @returns 磁盘脚本内容；未加载时返回空串（全部视为新增）。
   */
  function scriptExistingCode (): string {
    return scriptStage.value?.existingCode.value ?? ''
  }

  /**
   * 取指定卡片的实时保存状态。
   *
   * @param cardKey - 卡片唯一标识。
   * @returns 保存状态；卡片不存在时视为已保存。
   */
  function saveStateFor (cardKey: string): TAutoSaveState {
    return autoSaves.get(cardKey)?.state.value ?? 'saved'
  }

  /**
   * 取指定卡片的保存失败文案（错误条展示）。
   *
   * @param cardKey - 卡片唯一标识。
   * @returns 错误文案；无错误时返回空串。
   */
  function saveErrorMessageFor (cardKey: string): string {
    return autoSaves.get(cardKey)?.errorMessage.value ?? ''
  }

  /**
   * 用户点击「重试保存」。
   *
   * @param cardKey - 卡片唯一标识。
   * @returns 保存成功时返回 true。
   */
  async function retrySave (cardKey: string): Promise<boolean> {
    return (await autoSaves.get(cardKey)?.retry()) ?? false
  }

  /**
   * 用户选择「重新加载」：放弃本地改动，用磁盘内容覆盖卡片。
   *
   * 同时刷新用例版本与来源哈希——冲突多半来自用例变更，
   * 不同步会导致用户修正后重试仍然失败。
   *
   * @param cardKey - 卡片唯一标识。
   * @returns 重新加载完成后的 Promise。
   */
  async function reloadCard (cardKey: string): Promise<void> {
    const record = stages.value.find((stage) => stage.card?.key === cardKey)
    const autoSave = autoSaves.get(cardKey)
    if (!record || !autoSave) return

    await dependencyRefresh?.()

    const relativePath = record.card!.fileName
    const content = await readBackGeneratedFile(relativePath)
    if (content === null) return

    // 阶段实例是实时保存的内容源，必须与卡片一起更新，否则下一次输入会带上旧内容。
    if (record.kind === 'skill') skillStage.value?.updateContent(content)
    else scriptStage.value?.updateCode(content)

    stages.value = stages.value.map((stage) =>
      stage.card?.key === cardKey
        ? { ...stage, card: { ...stage.card!, content } }
        : stage,
    )
    autoSave.syncFromDisk(content, '')
  }

  /**
   * 静默 flush 全部卡片的待发改动（PRD 7.6）。
   *
   * 用于关闭侧边栏前：立即发起保存并等待完成，用户无感知。
   *
   * @returns 全部 flush 完成后兑现的 Promise。
   */
  async function flushAll (): Promise<void> {
    await Promise.all(
      [...autoSaves.values()].map((autoSave) => autoSave.flushSilently()),
    )
  }

  /**
   * 清空内容：销毁全部卡片与工作记录，**工作台保持展开**（v13 PRD B-6）。
   *
   * v13 把 v9 的 `close()`（清内容 + 收起）拆成两个动作，因为二者后果迥异：
   * 「清空」只丢弃过程记录，「收起」只隐藏界面。合并成一个按钮时，
   * 用户难以分辨自己点的是保留还是销毁（PRD §4.3 B-4）。
   *
   * 调用方（组件）需先完成 flush 与「保存失败」二次确认（PRD B-8），
   * 因为这些动作需要用户交互，不适合放在 store 内。
   */
  function reset (): void {
    for (const autoSave of autoSaves.values()) autoSave.dispose?.()
    autoSaves.clear()
    skillStage.value?.dispose()
    scriptStage.value?.dispose()
    skillStage.value = null
    scriptStage.value = null
    stages.value = []
    // 去重表随之清空：清空后是新的工作项，相同终态应当能再次通知。
    notifiedTerminals.clear()
  }

  /**
   * 关闭工作台：清空内容并收起（v9 `close()` 的旧语义）。
   *
   * v13 起**不再有 UI 入口**（卡片上的「关闭」按钮已移除，PRD B-4）；
   * 保留此组合动作供「清空后随即收起」的场景使用。
   */
  function close (): void {
    reset()
    globalChat.collapse()
  }

  /** 收起工作台：保留状态，仅隐藏（v9 PRD 4.3）。 */
  function collapse (): void {
    globalChat.collapse()
  }

  return {
    stages,
    phase,
    subtitle,
    isRunning,
    latestCardKey,
    sidebarItems,
    hasFlowData,
    hasUnsavedFailure,
    setDependencies,
    setSourceHash,
    setRefreshHandler,
    setTerminalNoticeSink,
    startSkillGeneration,
    startScriptGeneration,
    updateCardContent,
    setCardViewMode,
    cancelStage,
    sessionIdFor,
    primaryActionFor,
    scriptExistingCode,
    saveStateFor,
    saveErrorMessageFor,
    retrySave,
    reloadCard,
    flushAll,
    reset,
    close,
    collapse,
  }
})

/**
 * 构造一个「不可用」的脚本阶段选项，用于读取目标 Skill 用例失败的场景。
 *
 * 存在的意义是让失败**可见**：直接 `return false` 会让用户点了按钮却毫无反应。
 * 这里给出的选项不会真正发起生成（`canGenerate` 恒为 false），
 * 阶段状态由调用方直接置为失败并附上原因。
 *
 * @param skillId - 目标 Skill（仅用于错误定位）。
 * @returns 满足阶段选项形状的占位对象。
 * @throws 不抛出异常。
 */
function unavailableScriptOptions (skillId: string): IScriptStageOptions {
  return {
    skillId: ref(skillId),
    draft: ref(null),
    version: ref(''),
    sourceHash: ref(''),
    script: ref(null),
    dirty: ref(false),
    canGenerate: computed(() => false),
    saveTestCase: async () => false,
  }
}
