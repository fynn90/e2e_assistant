/**
 * 共享路径判定的单元测试（v16 §6.2）。
 *
 * 这三个纯函数是生成守卫与工作台守卫的共同底层：两者策略不同
 * （唯一目标 vs 工作区内多目标），但「什么算越界」「什么算敏感文件」
 * 必须一致——本测试锁定这份一致性，防止两侧分叉。
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  BLOCKED_READ_FILE_NAMES,
  PROTECTED_WRITE_FILE_NAMES,
  isPathInsideWorkspace,
  isPathWithFileNameIn,
} from '../../src/shared/path-guard'

const WORKSPACE = resolve('/tmp/authine-ws')
const SKILL = resolve(WORKSPACE, 'demo_abc123456')

describe('isPathInsideWorkspace', () => {
  it('工作区自身与子路径判定为内', () => {
    expect(isPathInsideWorkspace(WORKSPACE, WORKSPACE)).toBe(true)
    expect(isPathInsideWorkspace(WORKSPACE, resolve(SKILL, 'SKILL.md'))).toBe(
      true,
    )
    expect(isPathInsideWorkspace(WORKSPACE, 'demo_abc123456/SKILL.md')).toBe(
      true,
    )
    expect(isPathInsideWorkspace(WORKSPACE, './x/../y.txt')).toBe(true)
  })

  it('越界路径（绝对 / 相对 / 盘符）判定为外', () => {
    expect(isPathInsideWorkspace(WORKSPACE, '/etc/passwd')).toBe(false)
    expect(isPathInsideWorkspace(WORKSPACE, '../outside.txt')).toBe(false)
    expect(
      isPathInsideWorkspace(WORKSPACE, resolve(WORKSPACE, '..', 'z.txt')),
    ).toBe(false)
  })

  it('非字符串与空白路径判定为外（无法判定即拒绝）', () => {
    for (const value of [undefined, null, 42, '', '   ', {}]) {
      expect(isPathInsideWorkspace(WORKSPACE, value)).toBe(false)
    }
  })

  it('前缀相似的相邻目录不被误判为内', () => {
    // `/tmp/authine-ws-evil` 以 `/tmp/authine-ws` 为前缀，但不是其子目录。
    expect(
      isPathInsideWorkspace(WORKSPACE, resolve('/tmp', 'authine-ws-evil', 'x')),
    ).toBe(false)
  })
})

describe('isPathWithFileNameIn', () => {
  it('按 basename 大小写不敏感命中', () => {
    expect(
      isPathWithFileNameIn(
        WORKSPACE,
        resolve(SKILL, 'env.json'),
        BLOCKED_READ_FILE_NAMES,
      ),
    ).toBe(true)
    expect(
      isPathWithFileNameIn(
        WORKSPACE,
        resolve(SKILL, 'ENV.JSON'),
        BLOCKED_READ_FILE_NAMES,
      ),
    ).toBe(true)
    expect(
      isPathWithFileNameIn(WORKSPACE, 'env.json', BLOCKED_READ_FILE_NAMES),
    ).toBe(true)
  })

  it('其他文件名与目录中同名文件不命中', () => {
    expect(
      isPathWithFileNameIn(
        WORKSPACE,
        resolve(SKILL, 'manifest.json'),
        BLOCKED_READ_FILE_NAMES,
      ),
    ).toBe(false)
    expect(
      isPathWithFileNameIn(
        WORKSPACE,
        resolve(SKILL, 'docs/env.json'),
        BLOCKED_READ_FILE_NAMES,
      ),
    ).toBe(true)
  })
})

describe('受保护清单', () => {
  it('读禁清单只含值级敏感文件', () => {
    expect([...BLOCKED_READ_FILE_NAMES]).toEqual(['env.json'])
  })

  it('写禁清单覆盖 env.json 与三个平台维护文件（SEC-1②）', () => {
    expect([...PROTECTED_WRITE_FILE_NAMES].sort()).toEqual([
      'e2e_schema.json',
      'env.json',
      'manifest.json',
      'skill.list.json',
    ])
  })
})
