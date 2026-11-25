/**
 * 负责在 per-skill lock 内更新权威 manifest，并同步全局 Skill 查询投影。
 */
import path from 'node:path'
import { SKILL_MANIFEST_FILE_NAME } from '../constants'
import { resolveSkill } from '../detail'
import type { ISkillStorageOptions } from '../storage'
import {
  readFixedUtf8File,
  writeFixedUtf8File,
} from '../transaction/fixed-file-atomic-write'
import { projectManifestToSkillList } from './manifest-projection'
import { validateSkillManifest, type ISkillManifest } from './skill-manifest'

/**
 * 在调用方已经持有 Skill lock 时更新 manifest 和 skill.list projection。
 *
 * @param options - Skill 存储配置。
 * @param skillId - 九位 Skill ID。
 * @param update - 根据当前 manifest 生成下一版本的纯函数。
 * @returns 已持久化的新 manifest。
 */
export async function updateSkillManifestUnderLock(
  options: ISkillStorageOptions,
  skillId: string,
  update: (current: ISkillManifest) => ISkillManifest,
): Promise<ISkillManifest> {
  const resolvedSkill = await resolveSkill(options, skillId)
  const snapshot = await readFixedUtf8File(
    resolvedSkill.skillRoot,
    SKILL_MANIFEST_FILE_NAME,
  )

  if (!snapshot) {
    throw new Error('Skill manifest 不存在。')
  }

  const nextManifest = validateSkillManifest(update(resolvedSkill.manifest))
  await writeFixedUtf8File(
    resolvedSkill.skillRoot,
    SKILL_MANIFEST_FILE_NAME,
    `${JSON.stringify(nextManifest, null, 2)}\n`,
    snapshot.version,
  )
  await projectManifestToSkillList(options, nextManifest)
  return nextManifest
}

export { projectManifestToSkillList } from './manifest-projection'

/**
 * 读取 manifest 路径，供诊断和故障恢复测试使用。
 *
 * @param skillRoot - 已解析的 Skill 根目录。
 * @returns manifest.json 的绝对路径。
 */
export function getManifestPath(skillRoot: string): string {
  return path.join(skillRoot, SKILL_MANIFEST_FILE_NAME)
}
