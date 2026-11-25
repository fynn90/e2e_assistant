/**
 * 工作区执行工具工厂测试。
 *
 * 本文件验证 pi-agent-core 内置工具经过适配后，可以通过普通 AgentTool 的四参数
 * execute 方法在指定工作区中完成文件写入和读取。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorkspaceExecutionTools } from '../../src/tools'
import { deriveShellPathPrepend } from '../../src/tools/workspace-execution-tools'

/** 临时工作目录列表，用于在每个测试结束后清理文件系统资源。 */
const temporaryWorkspaces: string[] = []

/**
 * 创建一个供测试工具读写的隔离临时工作目录。
 *
 * @returns 新建临时目录的绝对路径。
 * @throws {Error} 当操作系统无法创建临时目录时，透传 Node.js 文件系统异常。
 */
async function createTemporaryWorkspace(): Promise<string> {
  // 将目录加入清理列表，确保失败场景同样不会残留测试文件。
  const workspace = await mkdtemp(join(tmpdir(), 'authine-e2e-agent-tools-'))
  temporaryWorkspaces.push(workspace)
  return workspace
}

afterEach(async () => {
  // 逐一清理本轮测试创建的目录，避免测试之间共享状态。
  await Promise.all(
    temporaryWorkspaces
      .splice(0)
      .map((workspace) => rm(workspace, { force: true, recursive: true })),
  )
})

describe('createWorkspaceExecutionTools', () => {
  /** 验证工厂导出的工具名称与预期的 pi-agent-core 内置工具一致。 */
  it('创建适配后的内置工具集合', () => {
    const tools = createWorkspaceExecutionTools(process.cwd())

    expect(tools.map((tool) => tool.name)).toEqual([
      'bash',
      'read',
      'write',
      'edit',
    ])
    expect(tools.every((tool) => tool.executionMode === 'sequential')).toBe(
      true,
    )
  })

  /** 验证工具适配器会为普通 AgentTool 调用自动补齐执行上下文。 */
  it('通过普通 AgentTool 签名读写指定工作区中的文件', async () => {
    const workspace = await createTemporaryWorkspace()
    const tools = createWorkspaceExecutionTools(workspace)
    const writeTool = tools.find((tool) => tool.name === 'write')
    const readTool = tools.find((tool) => tool.name === 'read')

    expect(writeTool).toBeDefined()
    expect(readTool).toBeDefined()

    // 使用四参数 execute 调用；若适配器未绑定 context，底层工具会因 env 缺失而失败。
    await writeTool!.execute(
      'write-test-call',
      { content: 'adapter works', path: 'result.txt' },
      undefined,
      undefined,
    )
    const result = await readTool!.execute(
      'read-test-call',
      { path: 'result.txt' },
      undefined,
      undefined,
    )

    expect(result.content).toEqual([{ text: 'adapter works', type: 'text' }])
  })

  /** 验证工厂拒绝没有默认工作目录的工具配置。 */
  it('拒绝空工作目录', () => {
    expect(() => createWorkspaceExecutionTools('   ')).toThrow(
      'workspaceCwd 不能为空',
    )
  })

  /** 验证 shellPath 会真正传到 NodeExecutionEnv：无效路径时 bash 拒绝执行并给出明确错误。 */
  it('bash 使用传入的 shellPath（无效路径时拒绝执行）', async () => {
    const workspace = await createTemporaryWorkspace()
    const tools = createWorkspaceExecutionTools(workspace, {
      shellPath: join(workspace, 'no-such-bash.exe'),
    })
    const bashTool = tools.find((tool) => tool.name === 'bash')

    expect(bashTool).toBeDefined()
    // NodeExecutionEnv 收到不存在的 shellPath 时以 shell_unavailable 拒绝执行，
    // 错误文案可区分「显式路径无效」与「平台缺省探测失败」两类场景。
    await expect(
      bashTool!.execute(
        'bash-shell-path-call',
        { command: 'echo hi' },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(/Custom shell path not found/)
  })
})

describe('deriveShellPathPrepend', () => {
  /** 验证 Git for Windows 的 usr\bin 形态会推导出 bash 目录与全部伴随工具目录。 */
  it('usr\\bin 形态推导出完整 Git 伴随目录', () => {
    const additions = deriveShellPathPrepend(
      'D:\\soft\\Git\\usr\\bin\\bash.exe',
    )

    expect(additions).toEqual([
      'D:\\soft\\Git\\usr\\bin',
      'D:\\soft\\Git\\mingw64\\bin',
      'D:\\soft\\Git\\cmd',
      'D:\\soft\\Git\\bin',
    ])
  })

  /** 验证 bin 形态同样能推导 Git 根，且 usr\bin 与 bin 形态的重复目录被去重。 */
  it('bin 形态推导 Git 根并去重', () => {
    const additions = deriveShellPathPrepend(
      'C:\\Program Files\\Git\\bin\\bash.exe',
    )

    expect(additions).toEqual([
      'C:\\Program Files\\Git\\bin',
      'C:\\Program Files\\Git\\mingw64\\bin',
      'C:\\Program Files\\Git\\cmd',
    ])
  })

  /** 验证非 Git 布局（无法识别根）时仅前置 bash 自身目录。 */
  it('无法识别 Git 布局时仅含 bash 自身目录', () => {
    const additions = deriveShellPathPrepend('D:\\tools\\shells\\bash.exe')

    expect(additions).toEqual(['D:\\tools\\shells'])
  })

  /** 验证正斜杠输入会归一为反斜杠形态。 */
  it('正斜杠输入归一为反斜杠', () => {
    const additions = deriveShellPathPrepend('D:/soft/Git/usr/bin/bash.exe')

    expect(additions[0]).toBe('D:\\soft\\Git\\usr\\bin')
  })
})
