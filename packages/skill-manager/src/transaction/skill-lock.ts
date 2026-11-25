/**
 * 提供稳定的 per-skill advisory lock，供跨文件业务事务统一串行化。
 */
import { lock } from 'proper-lockfile'
import { resolveSkill } from '../detail'
import type { ISkillStorageOptions } from '../storage'

/**
 * 锁定不可变的 Skill 目录，而不是会被 rename 替换的业务文件 inode。
 *
 * @param options - Skill 存储配置。
 * @param skillId - 九位 Skill ID。
 * @returns 释放锁的异步函数。
 */
export async function acquireSkillLock(
  options: ISkillStorageOptions,
  skillId: string,
): Promise<() => Promise<void>> {
  const resolvedSkill = await resolveSkill(options, skillId)
  return lock(resolvedSkill.skillRoot, { retries: 5, realpath: true })
}
