/**
 * 管理固定 SKILL.md 文件和 manifest.generatedSkill 元数据。
 *
 * Agent 负责通过受限 write 工具写入文档；仓储负责读取、版本校验、原子保存与元数据提交。
 *
 * v9 起不再有「候选 / 确认」两态：`save()` 接受任意正文（生成结果与用户手改同路径），
 * 原 `confirm()`（仅原样确认 Agent 已写入内容）已随该模型一并移除。
 */
import type {
  IFileSaveDiagnostic,
  ISaveSkillDocumentData,
  ISkillDocumentData,
  ISkillDocumentState,
} from '@charlie_deng/e2e-assistant-types'
import { SKILL_DOCUMENT_FILE_NAME, SKILL_MANIFEST_FILE_NAME } from './constants'
import { resolveSkill } from './detail'
import { SkillManagerError } from './errors'
import { updateSkillManifestUnderLock } from './manifest/manifest-repository'
import type { ISkillStorageOptions } from './storage'
import {
  readFixedUtf8File,
  restoreFixedUtf8File,
  writeFixedUtf8File,
} from './transaction/fixed-file-atomic-write'
import { acquireSkillLock } from './transaction/skill-lock'

/** 固定 SKILL.md 文件仓储契约。 */
export interface ISkillDocumentRepository {
  findBySkillId (skillId: string): Promise<ISkillDocumentData | null>
  getState (
    skillId: string,
    currentSourceHash: string,
  ): Promise<ISkillDocumentState>
  /**
   * 写入 SKILL.md 正文并提交 generatedSkill 元数据。
   *
   * 接受任意正文（生成结果与用户手改走同一条路径），不比对磁盘旧内容；
   * 并发安全由 expectedVersion 的原子写检查保证。
   *
   * @param skillId - Skill ID。
   * @param content - 待写入的完整正文。
   * @param sourceHash - 正文对应的 e2e_schema.json 来源哈希。
   * @param expectedVersion - 期望的当前文件版本；null 表示文件必须不存在。
   * @param diagnostics - 校验诊断（edit 模式收集；generation 模式为空）。
   * @returns 写入后的文件版本、元数据与诊断。
   */
  save (
    skillId: string,
    content: string,
    sourceHash: string,
    expectedVersion: string | null,
    diagnostics?: IFileSaveDiagnostic[],
  ): Promise<ISaveSkillDocumentData>
}

/** 固定 SKILL.md 文件仓储实现。 */
export class FileSkillDocumentRepository implements ISkillDocumentRepository {
  readonly #options: ISkillStorageOptions

  /**
   * @param options - Skill 存储根目录。
   */
  constructor(options: ISkillStorageOptions) {
    this.#options = options
  }

  /** 读取当前 Skill 的固定 SKILL.md 文件；文件不存在时返回 null。 */
  async findBySkillId (skillId: string): Promise<ISkillDocumentData | null> {
    const resolvedSkill = await resolveSkill(this.#options, skillId)
    const snapshot = await readFixedUtf8File(
      resolvedSkill.skillRoot,
      SKILL_DOCUMENT_FILE_NAME,
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

  /** 根据文档文件和 manifest 来源哈希计算当前状态。 */
  async getState (
    skillId: string,
    currentSourceHash: string,
  ): Promise<ISkillDocumentState> {
    const resolvedSkill = await resolveSkill(this.#options, skillId)
    const snapshot = await readFixedUtf8File(
      resolvedSkill.skillRoot,
      SKILL_DOCUMENT_FILE_NAME,
    )
    const metadata = resolvedSkill.manifest.generatedSkill

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
   * 原子创建或更新 SKILL.md，再更新 generatedSkill manifest 元数据。
   *
   * @param skillId - Skill ID。
   * @param content - 待写入的完整正文（生成结果或用户手改）。
   * @param sourceHash - 正文对应的 e2e_schema.json 来源哈希。
   * @param expectedVersion - 期望的当前文件版本；null 表示文件必须不存在。
   * @param diagnostics - 校验诊断，写入模式下仅回传给前端提示，不影响写入。
   * @returns 写入后的文件版本、元数据与诊断。
   * @throws SkillManagerError 当文件版本冲突、manifest 缺失或写入失败时抛出。
   */
  async save (
    skillId: string,
    content: string,
    sourceHash: string,
    expectedVersion: string | null,
    diagnostics: IFileSaveDiagnostic[] = [],
  ): Promise<ISaveSkillDocumentData> {
    const releaseSkillLock = await acquireSkillLock(this.#options, skillId)
    try {
      const resolvedSkill = await resolveSkill(this.#options, skillId)
      const documentSnapshot = await readFixedUtf8File(
        resolvedSkill.skillRoot,
        SKILL_DOCUMENT_FILE_NAME,
      )
      const manifestSnapshot = await readFixedUtf8File(
        resolvedSkill.skillRoot,
        SKILL_MANIFEST_FILE_NAME,
      )
      if (!manifestSnapshot) throw new Error('Skill manifest 不存在。')

      const result = await writeFixedUtf8File(
        resolvedSkill.skillRoot,
        SKILL_DOCUMENT_FILE_NAME,
        content,
        expectedVersion,
        // 保留磁盘原有的换行与 BOM：读版本基于原始字节，写回形态不一致会导致
        // 返回版本与再次读取的版本永不相等（Windows 下每次保存都伪冲突）。
        documentSnapshot
          ? {
            lineEnding: documentSnapshot.lineEnding,
            hasUtf8Bom: documentSnapshot.hasUtf8Bom,
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
            generatedSkill: {
              path: SKILL_DOCUMENT_FILE_NAME,
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
          SKILL_DOCUMENT_FILE_NAME,
          documentSnapshot,
          result.version,
        )
        throw error
      }
      return {
        relativePath: SKILL_DOCUMENT_FILE_NAME,
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
