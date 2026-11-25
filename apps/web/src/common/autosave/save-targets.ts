/**
 * 保存目标适配器：把「写到哪、怎么校验、冲突码是什么」收敛到 `ISaveTarget`。
 *
 * 适配器是实时保存能力的**唯一业务感知层**：编排层（`useAutoSave`）完全不知道
 * SKILL.md、test.spec.ts 与 env.json 的区别，因此同一套防抖 / 串行 / 重试逻辑可以
 * 直接服务产物卡片与文件树中的任意文本文件（校验阻断以 `EnvFileBlockedError` 表达，
 * 编排层只感知「校验阻断」类别，不感知具体业务）。
 *
 * 适配器内部持有可变的期望版本：成功后自行更新，避免调用方忘记回填
 * 导致第二次保存必然冲突。这样 `useAutoSave` 完全无状态于「版本」。
 */
import {
  parseEnvFileContent,
  PLAYWRIGHT_SCRIPT_FILE_NAME,
  SKILL_DOCUMENT_FILE_NAME,
  type IEnvFileIssue,
} from '@authine-e2e-agent/types'
import { saveSkillDocument } from '../../modules/e2e-test-case/services/skill-document-api'
import { savePlaywrightScript } from '../../modules/e2e-test-case/services/e2e-test-case-api'
import { updateSkillFile } from '../../services/skill-api'
import type { ISaveTarget, ISaveTargetResult } from './types'

/**
 * env.json 内容校验未通过时抛出的阻断异常（v10 PRD 5.3）。
 *
 * 携带完整的格式问题明细（行:列 + 原因），由 `useAutoSave` 分流为 blocked 态；
 * 阻断发生在请求发出之前，磁盘保持最近一份合法内容。
 */
export class EnvFileBlockedError extends Error {
  readonly code = 'ENV_FILE_INVALID'
  /** 全部格式问题（R1–R5 逐条）。 */
  readonly issues: IEnvFileIssue[]

  constructor(issues: IEnvFileIssue[]) {
    super(issues[0]?.message ?? 'env.json 校验未通过。')
    this.name = 'EnvFileBlockedError'
    this.issues = issues
  }
}

/**
 * 创建 SKILL.md 的保存目标。
 *
 * 走 `PUT /skill-document` 且固定 `mode: 'edit'`：生成完成时的首次落盘
 * 由生成流程以 `generation` 模式单独调用，实时编辑一律为 edit 语义。
 *
 * @param skillId - 当前 Skill ID。
 * @param sourceHash - 当前用例来源哈希（服务端据此拒绝陈旧文档）。
 * @param initialVersion - 初始期望文件版本；文件不存在时传 null。
 * @returns SKILL.md 保存目标。
 */
export function createSkillDocumentTarget(
  skillId: string,
  sourceHash: string,
  initialVersion: string | null,
): ISaveTarget {
  let expectedVersion = initialVersion

  return {
    key: SKILL_DOCUMENT_FILE_NAME,
    async save(content, signal): Promise<ISaveTargetResult> {
      const response = await saveSkillDocument(
        skillId,
        {
          content,
          sourceHash,
          expectedSkillDocumentVersion: expectedVersion,
          mode: 'edit',
        },
        signal,
      )
      expectedVersion = response.data.version
      return {
        version: response.data.version,
        diagnostics: response.data.diagnostics,
      }
    },
  }
}

/**
 * 创建 Playwright 脚本的保存目标。
 *
 * 走 `PUT /playwright-script` 且固定 `mode: 'edit'`：edit 模式服务端**不做格式化**，
 * 否则每次防抖保存都会用重排后的代码覆盖用户输入，表现为光标乱跳、缩进被反复纠正。
 *
 * @param skillId - 当前 Skill ID。
 * @param sourceHash - 当前用例来源哈希。
 * @param initialVersion - 初始期望文件版本；文件不存在时传 null。
 * @returns 脚本保存目标。
 */
export function createPlaywrightScriptTarget(
  skillId: string,
  sourceHash: string,
  initialVersion: string | null,
): ISaveTarget {
  let expectedVersion = initialVersion

  return {
    key: PLAYWRIGHT_SCRIPT_FILE_NAME,
    async save(content, signal): Promise<ISaveTargetResult> {
      const response = await savePlaywrightScript(
        skillId,
        {
          code: content,
          sourceHash,
          expectedScriptVersion: expectedVersion,
          mode: 'edit',
        },
        signal,
      )
      expectedVersion = response.data.version
      return {
        version: response.data.version,
        diagnostics: response.data.diagnostics,
      }
    },
  }
}

/**
 * 创建通用文本文件的保存目标。
 *
 * 走 `PUT /file`：服务端无业务校验，仅做原子写与版本检查，
 * 因此固定返回空诊断。
 *
 * @param skillId - 当前 Skill ID。
 * @param relativePath - 目标文件在 Skill 内的相对路径。
 * @param initialVersion - 初始期望文件版本。
 * @returns 通用文件保存目标。
 */
export function createGenericFileTarget(
  skillId: string,
  relativePath: string,
  initialVersion: string,
): ISaveTarget {
  let expectedVersion = initialVersion

  return {
    key: relativePath,
    async save(content, signal): Promise<ISaveTargetResult> {
      const response = await updateSkillFile(
        skillId,
        { relativePath, content, expectedVersion },
        signal,
      )
      expectedVersion = response.data.version
      return { version: response.data.version, diagnostics: [] }
    },
  }
}

/**
 * 创建 env.json 的保存目标（v10 PRD 5.3 阻断落盘，前端主路径）。
 *
 * 写入前先用与服务端闸门同一份 `parseEnvFileContent` 执行格式校验：
 *   - 存在问题：抛 `EnvFileBlockedError`（携带问题明细），请求不发出，
 *     由 `useAutoSave` 分流为 blocked 态（不退避重试）；
 *   - 校验通过：走既有 `updateSkillFile`，与通用文件目标的请求与版本回填一致。
 *
 * 服务端写闸门兜底其他客户端写入；两端共用同一份校验实现，判定必然一致。
 *
 * @param skillId - 当前 Skill ID。
 * @param relativePath - 固定为 `env.json`。
 * @param initialVersion - 初始期望文件版本。
 * @returns env.json 保存目标。
 */
export function createEnvFileTarget(
  skillId: string,
  relativePath: string,
  initialVersion: string,
): ISaveTarget {
  let expectedVersion = initialVersion

  return {
    key: relativePath,
    async save(content, signal): Promise<ISaveTargetResult> {
      // 客户端校验是主路径：非法内容在此拦截，请求不发出。
      const parsed = parseEnvFileContent(content)

      if (parsed.issues.length > 0) {
        throw new EnvFileBlockedError(parsed.issues)
      }

      const response = await updateSkillFile(
        skillId,
        { relativePath, content, expectedVersion },
        signal,
      )
      expectedVersion = response.data.version
      return { version: response.data.version, diagnostics: [] }
    },
  }
}
