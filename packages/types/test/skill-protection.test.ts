/**
 * 验证 Skill 根目录保护清单判定（v13 创建期文件 + v14 受保护根目录）。
 *
 * 重点固化 v14 缺陷 A 的回归：`isProtectedSkillRootEntry` 的目录名比较必须
 * **两侧都归一为小写**——清单以规范大小写 'userWorkSpace' 书写，只把入参
 * 小写化会永不命中，导致 W12/W13 的共享保护机制形同虚设。
 */
import { describe, expect, it } from 'vitest'
import {
  isProtectedSkillRootEntry,
  isProtectedSkillRootFile,
  PROTECTED_SKILL_ROOT_DIRECTORY_NAMES,
  PROTECTED_SKILL_ROOT_FILE_NAMES,
} from '../src/api/skill'

describe('isProtectedSkillRootFile（v13 创建期文件）', () => {
  it('命中三个创建期文件（大小写不敏感）', () => {
    for (const name of PROTECTED_SKILL_ROOT_FILE_NAMES) {
      expect(isProtectedSkillRootFile(name)).toBe(true)
      expect(isProtectedSkillRootFile(name.toUpperCase())).toBe(true)
    }
  })

  it('子目录中的同名文件不受保护', () => {
    expect(isProtectedSkillRootFile('sub/manifest.json')).toBe(false)
  })
})

describe('isProtectedSkillRootEntry（v14 扩展：文件 + 受保护根目录）', () => {
  it('保留 v13 语义：创建期文件仍命中', () => {
    expect(isProtectedSkillRootEntry('manifest.json')).toBe(true)
    expect(isProtectedSkillRootEntry('e2e_schema.json')).toBe(true)
    expect(isProtectedSkillRootEntry('env.json')).toBe(true)
  })

  it('缺陷 A 回归：userWorkSpace 根目录命中保护（大小写变体同样拦截，W12/W13）', () => {
    // 清单以规范大小写书写，入参大小写任意变体都必须命中。
    expect(isProtectedSkillRootEntry('userWorkSpace')).toBe(true)
    expect(isProtectedSkillRootEntry('UserWorkSpace')).toBe(true)
    expect(isProtectedSkillRootEntry('USERWORKSPACE')).toBe(true)
    expect(isProtectedSkillRootEntry('userworkspace')).toBe(true)
  })

  it('userWorkSpace 子内容不受根目录保护（W14：子内容可删）', () => {
    expect(isProtectedSkillRootEntry('userWorkSpace/baselines')).toBe(false)
    expect(isProtectedSkillRootEntry('userWorkSpace/a.png')).toBe(false)
  })

  it('非保护清单内的根条目放行', () => {
    expect(isProtectedSkillRootEntry('test.spec.ts')).toBe(false)
    expect(isProtectedSkillRootEntry('SKILL.md')).toBe(false)
    expect(isProtectedSkillRootEntry('temp')).toBe(false)
  })

  it('保护清单常量本身保持稳定契约', () => {
    expect(PROTECTED_SKILL_ROOT_DIRECTORY_NAMES).toEqual(['userWorkSpace'])
  })
})
