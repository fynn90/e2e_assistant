/**
 * 管理固定 `test.spec.ts` 文件和 manifest.generatedScript 元数据。
 */
import type {
  IFileSaveDiagnostic,
  IPlaywrightScriptState,
  ISavePlaywrightScriptData,
} from '@charlie_deng/e2e-assistant-types'
import {
  PLAYWRIGHT_SCRIPT_FILE_NAME,
  SKILL_MANIFEST_FILE_NAME,
} from '../constants'
import { resolveSkill } from '../detail'
import { updateSkillManifestUnderLock } from '../manifest/manifest-repository'
import type { ISkillStorageOptions } from '../storage'
import {
  readFixedUtf8File,
  restoreFixedUtf8File,
  writeFixedUtf8File,
} from '../transaction/fixed-file-atomic-write'
import { acquireSkillLock } from '../transaction/skill-lock'

export interface IPlaywrightScriptDocument {
  content: string
  version: string
  size: number
  updatedAt: string
}

export interface IPlaywrightScriptRepository {
  findBySkillId (skillId: string): Promise<IPlaywrightScriptDocument | null>
  getState (
    skillId: string,
    currentSourceHash: string,
  ): Promise<IPlaywrightScriptState>
  /**
   * 写入 test.spec.ts 正文并提交 generatedScript 元数据。
   *
   * 传入的 code 已由调用方完成校验（generation 模式写入格式化结果，
   * edit 模式写入用户原文），仓储本身不做格式化。
   *
   * @param skillId - Skill ID。
   * @param code - 待写入的完整脚本源码。
   * @param sourceHash - 脚本对应的 e2e_schema.json 来源哈希。
   * @param expectedVersion - 期望的当前文件版本；null 表示文件必须不存在。
   * @param diagnostics - 校验诊断（edit 模式收集；generation 模式为空）。
   * @returns 写入后的文件版本、元数据与诊断。
   */
  save (
    skillId: string,
    code: string,
    sourceHash: string,
    expectedVersion: string | null,
    diagnostics?: IFileSaveDiagnostic[],
  ): Promise<ISavePlaywrightScriptData>
}

export class FilePlaywrightScriptRepository implements IPlaywrightScriptRepository {
  readonly #options: ISkillStorageOptions

  constructor(options: ISkillStorageOptions) {
    this.#options = options
  }

  /** 读取当前 Skill 的固定 Playwright 脚本；文件不存在时返回 null。 */
  async findBySkillId (
    skillId: string,
  ): Promise<IPlaywrightScriptDocument | null> {
    const resolvedSkill = await resolveSkill(this.#options, skillId)
    const snapshot = await readFixedUtf8File(
      resolvedSkill.skillRoot,
      PLAYWRIGHT_SCRIPT_FILE_NAME,
    )

    return snapshot
      ? {
        content: snapshot.content,
        version: snapshot.version,
        size: snapshot.size,
        updatedAt: snapshot.updatedAt,
      }
      : null
  }

  /** 根据脚本文件、生成元数据和当前 sourceHash 计算前端展示状态。 */
  async getState (
    skillId: string,
    currentSourceHash: string,
  ): Promise<IPlaywrightScriptState> {
    const resolvedSkill = await resolveSkill(this.#options, skillId)
    const snapshot = await readFixedUtf8File(
      resolvedSkill.skillRoot,
      PLAYWRIGHT_SCRIPT_FILE_NAME,
    )
    const metadata = resolvedSkill.manifest.generatedScript

    if (!snapshot) {
      return {
        exists: false,
        status: 'not_generated',
        version: null,
        generatedAt: null,
        updatedAt: null,
        sourceHash: null,
      }
    }

    if (!metadata) {
      return {
        exists: true,
        status: 'untracked',
        version: snapshot.version,
        generatedAt: null,
        updatedAt: snapshot.updatedAt,
        sourceHash: null,
      }
    }

    return {
      exists: true,
      status: metadata.sourceHash === currentSourceHash ? 'current' : 'stale',
      version: snapshot.version,
      generatedAt: metadata.generatedAt,
      updatedAt: snapshot.updatedAt,
      sourceHash: metadata.sourceHash,
    }
  }

  /**
   * 原子创建或更新脚本，再更新可恢复的 generatedScript manifest 元数据。
   *
   * @param skillId - Skill ID。
   * @param code - 已校验的完整脚本源码。
   * @param sourceHash - 脚本对应的 e2e_schema.json 来源哈希。
   * @param expectedVersion - 期望的当前文件版本；null 表示文件必须不存在。
   * @param diagnostics - 校验诊断，仅回传给前端提示，不影响写入。
   * @returns 写入后的文件版本、元数据与诊断。
   * @throws SkillManagerError 当文件版本冲突、manifest 缺失或写入失败时抛出。
   */
  async save (
    skillId: string,
    code: string,
    sourceHash: string,
    expectedVersion: string | null,
    diagnostics: IFileSaveDiagnostic[] = [],
  ): Promise<ISavePlaywrightScriptData> {
    const releaseSkillLock = await acquireSkillLock(this.#options, skillId)

    try {
      const resolvedSkill = await resolveSkill(this.#options, skillId)
      const scriptSnapshot = await readFixedUtf8File(
        resolvedSkill.skillRoot,
        PLAYWRIGHT_SCRIPT_FILE_NAME,
      )
      const manifestSnapshot = await readFixedUtf8File(
        resolvedSkill.skillRoot,
        SKILL_MANIFEST_FILE_NAME,
      )

      if (!manifestSnapshot) {
        throw new Error('Skill manifest 不存在。')
      }

      const result = await writeFixedUtf8File(
        resolvedSkill.skillRoot,
        PLAYWRIGHT_SCRIPT_FILE_NAME,
        code,
        expectedVersion,
        // 保留磁盘原有的换行与 BOM，避免版本比对永久失配（G9）。
        scriptSnapshot
          ? {
            lineEnding: scriptSnapshot.lineEnding,
            hasUtf8Bom: scriptSnapshot.hasUtf8Bom,
          }
          : undefined,
      )
      const generatedAt = result.updatedAt

      try {
        await updateSkillManifestUnderLock(
          this.#options,
          skillId,
          (manifest) => ({
            ...manifest,
            updatedAt: result.updatedAt,
            generatedScript: {
              path: PLAYWRIGHT_SCRIPT_FILE_NAME,
              sourceHash,
              generatedAt,
            },
          }),
        )
      } catch (error) {
        const currentManifest = await readFixedUtf8File(
          resolvedSkill.skillRoot,
          SKILL_MANIFEST_FILE_NAME,
        )

        if (
          currentManifest &&
          currentManifest.version !== manifestSnapshot.version
        ) {
          await restoreFixedUtf8File(
            resolvedSkill.skillRoot,
            SKILL_MANIFEST_FILE_NAME,
            manifestSnapshot,
            currentManifest.version,
          )
        }

        await restoreFixedUtf8File(
          resolvedSkill.skillRoot,
          PLAYWRIGHT_SCRIPT_FILE_NAME,
          scriptSnapshot,
          result.version,
        )
        throw error
      }

      return {
        relativePath: PLAYWRIGHT_SCRIPT_FILE_NAME,
        version: result.version,
        size: result.size,
        sourceHash,
        generatedAt,
        updatedAt: result.updatedAt,
        diagnostics,
      }
    } finally {
      await releaseSkillLock()
    }
  }
}
