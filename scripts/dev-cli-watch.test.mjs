/**
 * 验证开发模式 CLI 自动重启脚本的文件过滤判定。
 *
 * 这里锁住的是一条真实踩过的坑：判定函数曾写成「忽略」语义却被当作「监听」使用，
 * 结果是 `.js` / `.ts` 恰好命中过滤条件而被全部跳过，表现为「改了文件但从不重启」，
 * 且不报任何错。因此必须逐条断言「该触发」与「不该触发」两侧。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  shouldWatchCliSource,
  shouldWatchPackageDist,
  WATCHED_PACKAGE_NAMES,
} from './dev-cli-watch.mjs'

const workspaceRootPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

test('CLI 源码：.ts 触发重启', () => {
  assert.equal(shouldWatchCliSource('stop-command.ts'), true)
  // fs.watch 在 Windows 上给出的是相对子路径，可能带目录分隔符。
  assert.equal(shouldWatchCliSource('commands\\stop-command.ts'), true)
  assert.equal(shouldWatchCliSource('application/service-lifecycle.ts'), true)
})

test('CLI 源码：非 .ts 不触发重启', () => {
  assert.equal(shouldWatchCliSource('start-terminal-ui.js'), false)
  assert.equal(shouldWatchCliSource('notes.md'), false)
  assert.equal(shouldWatchCliSource('.DS_Store'), false)
  // 编辑器临时文件形如 foo.ts~ 或 .#foo.ts，不应因「含 .ts」而误触发。
  assert.equal(shouldWatchCliSource('stop-command.ts~'), false)
})

test('依赖包产物：.js 触发重启', () => {
  assert.equal(shouldWatchPackageDist('index.js'), true)
  assert.equal(shouldWatchPackageDist('chunk-ABC123.js'), true)
})

test('依赖包产物：sourcemap 与类型声明不触发重启', () => {
  // tsup 一次重建会写出 index.js / index.js.map / index.d.ts；
  // 若都触发，同一次重建会让 CLI 连续重启多次。
  assert.equal(shouldWatchPackageDist('index.js.map'), false)
  assert.equal(shouldWatchPackageDist('index.d.ts'), false)
  assert.equal(shouldWatchPackageDist('index.mjs'), false)
})

test('监听包清单包含服务层、web-host 与各被依赖包，且不含 web', () => {
  assert.ok(WATCHED_PACKAGE_NAMES.includes('service'))
  // web-host 承载静态托管，改它同样要重启 CLI 才能生效。
  assert.ok(WATCHED_PACKAGE_NAMES.includes('web-host'))
  assert.ok(WATCHED_PACKAGE_NAMES.includes('agent'))
  // web 是前端产物，由 Vite 自行处理；CLI 只在运行期读取它的 dist 目录。
  assert.ok(!WATCHED_PACKAGE_NAMES.includes('web'))
})

test('被监听的每个包都必须是 dev:workbench 的参与者', () => {
  // 只把包名加进监听清单是不够的：若该包没有 `dev` 脚本、也没进 dev:workbench 编排，
  // 它的 dist 永远不会重建，watcher 监听了目录也收不到变化——
  // 表现为「改了源码但 CLI 不重启」且不报任何错。web-host 曾因此漏掉。
  const rootPackageJson = JSON.parse(
    readFileSync(path.join(workspaceRootPath, 'package.json'), 'utf-8'),
  )
  const workbenchCommand = rootPackageJson.scripts['dev:workbench']

  for (const packageName of WATCHED_PACKAGE_NAMES) {
    const packageJson = JSON.parse(
      readFileSync(
        path.join(workspaceRootPath, 'packages', packageName, 'package.json'),
        'utf-8',
      ),
    )

    assert.ok(
      packageJson.scripts?.dev,
      `被监听的包 ${packageName} 缺少 dev 脚本，其 dist 不会重建`,
    )
    assert.ok(
      workbenchCommand.includes(`dev:${packageName}`),
      `被监听的包 ${packageName} 未加入 dev:workbench 编排，开发时不会被 watch`,
    )
  }
})

test('dev:workbench 的进程名与并发命令数量一致', () => {
  // concurrently 的 -n 名称列表与命令列表长度不一致时会静默错位，
  // 日志前缀会对错进程，排障时极易误判。
  const rootPackageJson = JSON.parse(
    readFileSync(path.join(workspaceRootPath, 'package.json'), 'utf-8'),
  )
  const workbenchCommand = rootPackageJson.scripts['dev:workbench']
  const namesMatch = workbenchCommand.match(/-n ([\w,-]+)/)
  const commandCount = (workbenchCommand.match(/pnpm run dev:/g) ?? []).length

  assert.ok(namesMatch, 'dev:workbench 未声明 -n 进程名列表')
  assert.equal(
    namesMatch[1].split(',').length,
    commandCount,
    '进程名数量与并发命令数量不一致',
  )
})
