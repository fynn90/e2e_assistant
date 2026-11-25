/**
 * 脚本生成的上下文解析（v13 需求 3）。
 *
 * **要解决的问题**：`generation-flow` 的阶段依赖（用例版本、来源哈希、脚本状态、
 * 就绪判定）由结构化用例编辑器在 `setup` 时注入，而那份依赖是**模块级单例槽位**
 * ——后挂载的编辑器会覆盖它。工作台全局化后，用户可以在「工作台显示 Skill A 的
 * 生成」时进入 Skill B 的开发页，此时槽位已指向 B；若仍按槽位生成，会**给错误的
 * Skill 生成脚本**。
 *
 * **本模块的职责**：为「要生成脚本的那个 Skill」解析出一份可信的上下文。
 *   - 槽位正好指向该 Skill：直接复用（省一次网络请求，也保留用户未保存的草稿语义）；
 *   - 槽位指向别的 Skill 或不可用：**从服务端重新读取该 Skill 的用例**，
 *     据磁盘状态构造上下文（此时不存在未保存草稿，`dirty` 为 false）。
 */
import { computed, ref, type Ref } from 'vue'
import type {
  IE2ETestCase,
  IPlaywrightScriptState,
} from '@charlie_deng/e2e-assistant-types'
import { fetchE2ETestCase } from '../e2e-test-case/services/e2e-test-case-api'
import { getDraftGenerationIssues } from '../e2e-test-case/validation/test-case-form-validator'
import type { IScriptStageOptions } from './script-stage'

/** 解析结果：可直接交给 `createScriptStage` 的阶段选项。 */
export interface IScriptContextResolution {
  /** 目标 Skill（恒等于请求解析的那个）。 */
  skillId: string
  /** 阶段选项。 */
  options: IScriptStageOptions
  /** 该上下文对应的来源哈希（实时保存目标需要它）。 */
  sourceHash: string
  /** 是否来自服务端重新读取（用于诊断与测试断言）。 */
  loadedFromServer: boolean
}

/**
 * 为一个 Skill 解析脚本生成上下文。
 *
 * @param input.skillId - 目标 Skill（来自工作台显示主体，不来自路由）。
 * @param input.injected - 编辑器注入的依赖；为 null 表示尚无任何编辑器挂载过。
 * @param input.injectedSourceHash - 注入依赖对应的来源哈希。
 * @param input.fetchCase - 读取用例的函数（可注入，便于测试）。
 * @returns 解析结果。
 * @throws 当服务端读取失败时向上抛出（调用方负责转为失败卡片）。
 */
export async function resolveScriptContext (input: {
  skillId: string
  injected: IScriptStageOptions | null
  injectedSourceHash: string
  fetchCase?: (skillId: string) => Promise<{
    testCase: IE2ETestCase
    version: string
    sourceHash: string
    script: IPlaywrightScriptState
  }>
}): Promise<IScriptContextResolution> {
  const { skillId, injected, injectedSourceHash } = input

  // 槽位正指向目标 Skill：复用注入依赖。它带有用户当前的草稿与 dirty 语义，
  // 比重新读取更准确（重新读取会丢掉「先保存再生成」这一步的自然衔接）。
  if (injected && injected.skillId.value === skillId) {
    return {
      skillId,
      options: injected,
      sourceHash: injectedSourceHash,
      loadedFromServer: false,
    }
  }

  // 槽位指向别的 Skill（或不存在）：从服务端读取目标 Skill 的磁盘状态。
  const load = input.fetchCase ?? defaultFetchCase
  const document = await load(skillId)

  // 用请求结果的常量构造只读上下文。
  // `dirty` 恒为 false —— 内容刚从磁盘读出，没有未保存改动，
  // 因此阶段不会走「先保存用例」的分支；`canGenerate` 用与编辑器同一个
  // 校验器派生，保证「能不能生成」的判定口径完全一致。
  const draft: Ref<IE2ETestCase | null> = ref(document.testCase)

  const options: IScriptStageOptions = {
    skillId: ref(skillId),
    draft,
    version: ref(document.version),
    sourceHash: ref(document.sourceHash),
    script: ref<IPlaywrightScriptState | null>(document.script),
    // 内容刚从磁盘读出，没有未保存改动，因此阶段不会走「先保存用例」的分支。
    dirty: ref(false),
    // 与编辑器共用同一个校验器，保证「能不能生成」的判定口径完全一致。
    canGenerate: computed(
      () => getDraftGenerationIssues(document.testCase).length === 0,
    ),
    saveTestCase: async () => true,
  }

  return {
    skillId,
    options,
    sourceHash: document.sourceHash,
    loadedFromServer: true,
  }
}

/**
 * 默认的用例读取：只取上下文需要的四个字段。
 *
 * @param skillId - 目标 Skill。
 * @returns 磁盘上的用例、版本、来源哈希与脚本状态。
 * @throws ApiClientError 当本地服务返回错误时抛出。
 */
async function defaultFetchCase (skillId: string) {
  const response = await fetchE2ETestCase(skillId)
  return {
    testCase: response.data.testCase,
    version: response.data.version,
    sourceHash: response.data.sourceHash,
    script: response.data.script,
  }
}
