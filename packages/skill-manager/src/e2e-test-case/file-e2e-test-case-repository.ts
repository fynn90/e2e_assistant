/**
 * 实现 `e2e_schema.json` 的固定文件仓储、领域校验、sourceHash 和投影同步。
 */
import {
  E2E_SCHEMA_VERSION,
  parseE2ETestCase,
  validateE2ETestCaseForSave,
  type IE2ETestCase,
} from '@charlie_deng/e2e-assistant-types'
import { E2E_SCHEMA_FILE_NAME, SKILL_MANIFEST_FILE_NAME } from '../constants'
import { resolveSkill } from '../detail'
import { SkillManagerError } from '../errors'
import { updateSkillManifestUnderLock } from '../manifest/manifest-repository'
import {
  FilePlaywrightScriptRepository,
  type IPlaywrightScriptRepository,
} from '../playwright-script/playwright-script-repository'
import type { ISkillStorageOptions } from '../storage'
import {
  readFixedUtf8File,
  restoreFixedUtf8File,
  writeFixedUtf8File,
} from '../transaction/fixed-file-atomic-write'
import { acquireSkillLock } from '../transaction/skill-lock'
import type {
  IE2ETestCaseDocument,
  IE2ETestCaseRepository,
  ISaveE2ETestCaseResult,
} from './e2e-test-case-repository'
import { canonicalizeE2ETestCase, serializeE2ETestCase } from './serializer'
import { calculateE2ESourceHash } from './source-hash'

export class FileE2ETestCaseRepository implements IE2ETestCaseRepository {
  readonly #options: ISkillStorageOptions
  readonly #scriptRepository: IPlaywrightScriptRepository

  constructor(
    options: ISkillStorageOptions,
    scriptRepository: IPlaywrightScriptRepository = new FilePlaywrightScriptRepository(
      options,
    ),
  ) {
    this.#options = options
    this.#scriptRepository = scriptRepository
  }

  /** 读取、校验并在需要时修复 manifest/list 查询投影。 */
  async findBySkillId (skillId: string): Promise<IE2ETestCaseDocument> {
    const resolvedSkill = await resolveSkill(this.#options, skillId)
    const snapshot = await readFixedUtf8File(
      resolvedSkill.skillRoot,
      E2E_SCHEMA_FILE_NAME,
    )

    if (!snapshot) {
      throw new SkillManagerError('FILE_NOT_FOUND', 'E2E 测试用例文件不存在。')
    }

    const testCase = parseStoredTestCase(snapshot.content)
    const sourceHash = calculateE2ESourceHash(testCase)

    if (
      resolvedSkill.manifest.title !== testCase.title.trim() ||
      resolvedSkill.manifest.description !== testCase.description.trim() ||
      !resolvedSkill.manifest.directoryName
    ) {
      await this.#reconcileManifest(skillId, testCase)
    }

    return {
      testCase,
      version: snapshot.version,
      sourceHash,
      updatedAt: snapshot.updatedAt,
      script: await this.#scriptRepository.getState(skillId, sourceHash),
    }
  }

  /** 在 per-skill lock 内保存权威用例文件，再同步 manifest 和全局索引投影。 */
  async save (
    skillId: string,
    testCase: IE2ETestCase,
    expectedVersion: string,
  ): Promise<ISaveE2ETestCaseResult> {
    const parsedTestCase = parseE2ETestCase(testCase)
    const issues = validateE2ETestCaseForSave(parsedTestCase)

    if (issues.length > 0) {
      throw new SkillManagerError(
        'E2E_SCHEMA_INVALID',
        issues[0]?.message ?? 'E2E 用例不合法。',
        issues,
      )
    }

    const canonicalTestCase = canonicalizeE2ETestCase(parsedTestCase)

    const releaseSkillLock = await acquireSkillLock(this.#options, skillId)

    try {
      const resolvedSkill = await resolveSkill(this.#options, skillId)
      const schemaSnapshot = await readFixedUtf8File(
        resolvedSkill.skillRoot,
        E2E_SCHEMA_FILE_NAME,
      )
      const manifestSnapshot = await readFixedUtf8File(
        resolvedSkill.skillRoot,
        SKILL_MANIFEST_FILE_NAME,
      )

      if (!schemaSnapshot || !manifestSnapshot) {
        throw new SkillManagerError(
          'FILE_NOT_FOUND',
          'E2E 用例或 Skill manifest 不存在。',
        )
      }

      const serialized = serializeE2ETestCase(canonicalTestCase)
      const result = await writeFixedUtf8File(
        resolvedSkill.skillRoot,
        E2E_SCHEMA_FILE_NAME,
        serialized,
        expectedVersion,
      )
      const sourceHash = calculateE2ESourceHash(canonicalTestCase)

      try {
        await updateSkillManifestUnderLock(
          this.#options,
          skillId,
          (manifest) => ({
            ...manifest,
            title: canonicalTestCase.title,
            description: canonicalTestCase.description,
            directoryName:
              manifest.directoryName ?? resolvedSkill.manifest.directoryName,
            updatedAt: result.updatedAt,
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
          E2E_SCHEMA_FILE_NAME,
          schemaSnapshot,
          result.version,
        )
        throw error
      }

      return {
        testCase: canonicalTestCase,
        version: result.version,
        sourceHash,
        updatedAt: result.updatedAt,
        title: canonicalTestCase.title,
        description: canonicalTestCase.description,
        script: await this.#scriptRepository.getState(skillId, sourceHash),
      }
    } finally {
      await releaseSkillLock()
    }
  }

  async #reconcileManifest (
    skillId: string,
    testCase: IE2ETestCase,
  ): Promise<void> {
    const releaseSkillLock = await acquireSkillLock(this.#options, skillId)

    try {
      const resolvedSkill = await resolveSkill(this.#options, skillId)
      await updateSkillManifestUnderLock(
        this.#options,
        skillId,
        (manifest) => ({
          ...manifest,
          title: testCase.title.trim(),
          description: testCase.description.trim(),
          directoryName:
            manifest.directoryName ?? resolvedSkill.manifest.directoryName,
        }),
      )
    } finally {
      await releaseSkillLock()
    }
  }
}

function parseStoredTestCase (content: string): IE2ETestCase {
  let input: unknown

  try {
    input = JSON.parse(content)
  } catch (error) {
    throw new SkillManagerError(
      'E2E_SCHEMA_INVALID',
      'e2e_schema.json 不是合法 JSON。',
      error,
    )
  }

  if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    (input as { schemaVersion?: unknown }).schemaVersion !== E2E_SCHEMA_VERSION
  ) {
    throw new SkillManagerError(
      'E2E_SCHEMA_VERSION_UNSUPPORTED',
      '当前版本不支持该 E2E Schema 版本。',
    )
  }

  try {
    return parseE2ETestCase(input)
  } catch (error) {
    throw new SkillManagerError(
      'E2E_SCHEMA_INVALID',
      'e2e_schema.json 数据结构不正确。',
      error,
    )
  }
}
