/**
 * 验证开发数据库重置脚本的文件枚举、删除范围与确认保护。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { resetDevDatabase } from './reset-dev-database.mjs'

let workspace = ''
let configRoot = ''
const originalXdg = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

/** 临时屏蔽 console 输出，避免测试日志干扰结果。 */
function silenceConsole () {
  const originalError = console.error
  const originalLog = console.log
  console.error = () => undefined
  console.log = () => undefined
  return () => {
    console.error = originalError
    console.log = originalLog
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'reset-db-ws-'))
  configRoot = mkdtempSync(join(tmpdir(), 'reset-db-cfg-'))
  mkdirSync(join(workspace, '.e2e-agent'), { recursive: true })
  mkdirSync(join(configRoot, 'e2e_assistant'), { recursive: true })
  writeFileSync(
    join(configRoot, 'e2e_assistant', 'config.json'),
    JSON.stringify({ projectDirectory: workspace }),
    'utf8',
  )
  // Win32 走 APPDATA、POSIX 走 XDG_CONFIG_HOME；两者都指向临时目录以保证跨平台生效。
  process.env.XDG_CONFIG_HOME = configRoot
  process.env.APPDATA = configRoot
})

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  rmSync(workspace, { recursive: true, force: true })
  rmSync(configRoot, { recursive: true, force: true })
})

/** 在工作区数据目录下创建一个文件。 */
function touch (name) {
  writeFileSync(join(workspace, '.e2e-agent', name), 'x', 'utf8')
}

/** 判断工作区数据目录下文件是否存在。 */
function exists (name) {
  return existsSync(join(workspace, '.e2e-agent', name))
}

test('删除数据库及其 WAL 附属文件，保留无关文件', async () => {
  const restore = silenceConsole()
  try {
    touch('work-blocks.db')
    touch('work-blocks.db-wal')
    touch('work-blocks.db-shm')
    touch('sessions.db')
    touch('notes.txt')

    const exitCode = await resetDevDatabase({ yes: true })

    assert.equal(exitCode, 0)
    assert.equal(exists('work-blocks.db'), false)
    assert.equal(exists('work-blocks.db-wal'), false)
    assert.equal(exists('work-blocks.db-shm'), false)
    assert.equal(exists('sessions.db'), false)
    // 非数据库文件必须保留，避免脚本误删工作区其他内容
    assert.equal(exists('notes.txt'), true)
  } finally {
    restore()
  }
})

test('无数据库文件时视为成功（幂等）', async () => {
  const restore = silenceConsole()
  try {
    touch('notes.txt')
    assert.equal(await resetDevDatabase({ yes: true }), 0)
    assert.equal(exists('notes.txt'), true)
  } finally {
    restore()
  }
})

test('数据目录不存在时也视为成功', async () => {
  const restore = silenceConsole()
  try {
    rmSync(join(workspace, '.e2e-agent'), { recursive: true, force: true })
    assert.equal(await resetDevDatabase({ yes: true }), 0)
  } finally {
    restore()
  }
})

test('未确认时不删除任何文件', async () => {
  const restore = silenceConsole()
  try {
    touch('work-blocks.db')
    // 非 TTY 且未传 --yes：应拒绝执行而不是静默删除
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
    try {
      assert.equal(await resetDevDatabase({ yes: false }), 1)
      assert.equal(exists('work-blocks.db'), true)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      })
    }
  } finally {
    restore()
  }
})

test('配置缺失时返回失败码', async () => {
  const restore = silenceConsole()
  try {
    rmSync(join(configRoot, 'e2e_assistant', 'config.json'), { force: true })
    assert.equal(await resetDevDatabase({ yes: true }), 1)
  } finally {
    restore()
  }
})
