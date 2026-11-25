/**
 * 锁定用户级配置根目录的平台分支行为。
 *
 * 这段解析逻辑被 CLI（runtime.json）与服务层（config.json）共同依赖，两者必须落在
 * 同一目录下；e2e 用例通过设置 APPDATA / XDG_CONFIG_HOME 隔离配置目录，因此
 * 任何行为差异都会让 e2e 失败或污染开发者真实配置。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  getAuthineConfigDirectory,
  getUserConfigRootDirectory,
} from '../src/index'

const originalAppData = process.env.APPDATA
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(() => {
  delete process.env.APPDATA
  delete process.env.XDG_CONFIG_HOME
})

afterEach(() => {
  // 未定义时删除而非赋 undefined，后者会留下字符串 "undefined"。
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData

  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
})

describe('getUserConfigRootDirectory', () => {
  it('Windows 优先使用 APPDATA', () => {
    if (process.platform !== 'win32') return

    process.env.APPDATA = 'D:\\temp\\app-data'

    expect(getUserConfigRootDirectory()).toBe('D:\\temp\\app-data')
  })

  it('Windows 在 APPDATA 缺失时兜底到 homedir/AppData/Roaming', () => {
    if (process.platform !== 'win32') return

    expect(getUserConfigRootDirectory()).toBe(
      path.join(homedir(), 'AppData', 'Roaming'),
    )
  })

  it('POSIX 优先使用 XDG_CONFIG_HOME', () => {
    if (process.platform === 'win32') return

    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config-home'

    expect(getUserConfigRootDirectory()).toBe('/tmp/xdg-config-home')
  })

  it('POSIX 在 XDG_CONFIG_HOME 缺失时兜底到 homedir/.config', () => {
    if (process.platform === 'win32') return

    expect(getUserConfigRootDirectory()).toBe(path.join(homedir(), '.config'))
  })

  it('忽略只含空白的环境变量值', () => {
    process.env.APPDATA = '   '
    process.env.XDG_CONFIG_HOME = '   '

    const expected = process.platform === 'win32'
      ? path.join(homedir(), 'AppData', 'Roaming')
      : path.join(homedir(), '.config')

    expect(getUserConfigRootDirectory()).toBe(expected)
  })

  it('每次调用都重新读取环境变量（测试可在运行中切换隔离目录）', () => {
    const firstDirectory = getUserConfigRootDirectory()

    if (process.platform === 'win32') {
      process.env.APPDATA = 'D:\\temp\\switched'
      expect(getUserConfigRootDirectory()).toBe('D:\\temp\\switched')
    } else {
      process.env.XDG_CONFIG_HOME = '/tmp/switched'
      expect(getUserConfigRootDirectory()).toBe('/tmp/switched')
    }

    expect(getUserConfigRootDirectory()).not.toBe(firstDirectory)
  })
})

describe('getAuthineConfigDirectory', () => {
  it('在用户级配置根目录下拼接固定的 e2e_assistant 目录名', () => {
    if (process.platform === 'win32') {
      process.env.APPDATA = 'D:\\temp\\app-data'
    } else {
      process.env.XDG_CONFIG_HOME = '/tmp/xdg-config-home'
    }

    expect(getAuthineConfigDirectory()).toBe(
      path.join(getUserConfigRootDirectory(), 'e2e_assistant'),
    )
  })
})
