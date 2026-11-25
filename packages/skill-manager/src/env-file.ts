/**
 * env.json（Skill 敏感数据文件，v10 PRD 4.1）的存在性保障。
 *
 * 单一职责：确保 Skill 目录存在 env.json，缺失时以默认空对象补建。
 * 补建是「打开页面」级别的语义——挂载在详情读取与文件树读取入口，
 * 而非被写路径高频复用的 `resolveSkill`，避免给每次保存增加额外 IO。
 */

import { access } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { DEFAULT_ENV_FILE_CONTENT } from '@charlie_deng/e2e-assistant-types'
import { SKILL_ENV_FILE_NAME } from './constants'
import { resolveSkill } from './detail'
import { isFileSystemMissingError } from './errors'
import type { ISkillStorageOptions } from './storage'

/**
 * 确保 Skill 目录存在 env.json；缺失且 Skill 可写时原子补建默认内容。
 *
 * 行为（PRD 4.1）：
 *   - env.json 已存在：不重写，直接返回 false；
 *   - 缺失且 Skill 可写：以 `writeFileAtomic`（0o600 + fsync）补建 `{}`，返回 true；
 *   - 缺失且 Skill 只读：跳过补建（无法写入），返回 false；
 *   - 任何兜底失败（权限 / 磁盘）：吞掉异常返回 false，下次打开重试。
 *
 * @param options - Skill 存储根目录配置。
 * @param skillId - 九位 Skill ID。
 * @returns 本次执行了补建时返回 true；已存在、只读或兜底失败返回 false。
 * @throws 不抛出异常——补建失败降级为「文件树中暂无 env.json」，不阻断调用方流程。
 */
export async function ensureEnvFile (
  options: ISkillStorageOptions,
  skillId: string,
): Promise<boolean> {
  try {
    const resolvedSkill = await resolveSkill(options, skillId)

    // 只读 Skill 不自动补建（PRD 4.1：无法写入，界面按「缺失且只读」提示）。
    if (resolvedSkill.detail.readOnly) {
      return false
    }

    const envFilePath = path.join(resolvedSkill.skillRoot, SKILL_ENV_FILE_NAME)

    try {
      await access(envFilePath)
      // 已存在：幂等返回，不重写用户内容。
      return false
    } catch (error) {
      if (!isFileSystemMissingError(error)) {
        // 非缺失类错误（如权限）：按兜底失败处理，不阻断调用方。
        return false
      }
    }

    await writeFileAtomic(envFilePath, DEFAULT_ENV_FILE_CONTENT, {
      encoding: 'utf-8',
      mode: 0o600,
      fsync: true,
    })
    return true
  } catch {
    // 兜底失败：详情 / 文件树照常返回，下次打开时重试补建。
    return false
  }
}
