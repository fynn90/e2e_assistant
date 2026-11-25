/**
 * 将权威 Skill manifest 同步到可重建的 skill.list.json 查询投影。
 */
import { lock } from 'proper-lockfile'
import writeFileAtomic from 'write-file-atomic'
import type { ISkillStorageOptions } from '../storage'
import { ensureSkillListFile, readRawSkillList } from '../storage'
import type { ISkillManifest } from './skill-manifest'

/**
 * 将当前 manifest 写入 skill.list.json。
 *
 * @param options - Skill 存储配置。
 * @param manifest - 权威持久化 manifest。
 */
export async function projectManifestToSkillList(
  options: ISkillStorageOptions,
  manifest: ISkillManifest,
): Promise<void> {
  const listPath = await ensureSkillListFile(options.rootDir)
  const releaseListLock = await lock(listPath, { retries: 5 })

  try {
    const rawList = await readRawSkillList(listPath)
    const nextList = rawList.map((entry) => {
      if (
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        (entry as { id?: unknown }).id === manifest.id
      ) {
        return manifest
      }

      return entry
    })

    if (!nextList.some((entry) => entry === manifest)) {
      nextList.push(manifest)
    }

    await writeFileAtomic(listPath, `${JSON.stringify(nextList, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      fsync: true,
    })
  } finally {
    await releaseListLock()
  }
}
