/**
 * 生成期的凭据解析器（v20 凭据代理）。
 *
 * 职责：实现 playwright-engine 的 `ICredentialResolver` 端口——引擎/Agent 只给出
 * `${ENV:KEY}` 引用，本模块读 env.json 换取真值，供填入页面时使用。
 *
 * 边界（与执行链路 §5.3「唯一接触值的位置」同源姿态）：
 *   - 值只在 `resolve()` 的这一次调用中从磁盘读到内存，随即交还调用方；
 *   - 值不写日志、不进事件、不进错误消息——失败一律归类为稳定原因码；
 *   - 每次调用重新读盘：生成任务可能持续数分钟，用户可以在此期间补充 env.json，
 *     缓存会让「补了值却仍报未找到」变成难以解释的现象。
 */

import {
  readSkillFile,
  SKILL_ENV_FILE_NAME,
} from '@authine-e2e-agent/skill-manager'
import { parseEnvFileContent } from '@authine-e2e-agent/types'
import type {
  ICredentialResolution,
  ICredentialResolver,
} from '@authine-e2e-agent/playwright-engine'

/**
 * 创建绑定某个 Skill 的凭据解析器。
 *
 * @param options - Skill 存储根目录与目标 Skill ID。
 * @returns 供浏览器会话注入的凭据解析端口。
 * @throws 不抛出异常——创建阶段不做任何 IO。
 */
export function createSkillCredentialResolver(options: {
  rootDir: string
  skillId: string
}): ICredentialResolver {
  return {
    async resolve(key: string): Promise<ICredentialResolution> {
      const values = await readEnvValues(options)

      if (values === null) {
        // 文件缺失或格式非法：两者对使用者而言的修复动作相同（去修 env.json），
        // 因此归为同一原因，不额外区分——错误码越少，文案越不容易失配。
        return { ok: false, reason: 'unavailable' }
      }

      const value = values[key]

      if (value === undefined) {
        return { ok: false, reason: 'not-found' }
      }

      if (value.length === 0) {
        return { ok: false, reason: 'empty' }
      }

      return { ok: true, value }
    },
  }
}

/**
 * 读取并解析 env.json 的值表。
 *
 * @param options - Skill 存储根目录与 Skill ID。
 * @returns 合法的 key→value 表；文件缺失或格式非法时返回 null。
 * @throws 不抛出异常——读取失败按「不可用」处理，与生成期就绪校验的降级口径一致。
 */
async function readEnvValues(options: {
  rootDir: string
  skillId: string
}): Promise<Record<string, string> | null> {
  try {
    const file = await readSkillFile(options, options.skillId, SKILL_ENV_FILE_NAME)
    const parsed = parseEnvFileContent(file.content)

    if (parsed.issues.length > 0 || parsed.data === null) {
      return null
    }

    return parsed.data
  } catch {
    return null
  }
}
