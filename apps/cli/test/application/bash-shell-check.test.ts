/**
 * bash 可执行文件探测的单元测试。
 *
 * 覆盖候选收集、Git 安装根反推与 where 输出解析等纯函数：固定候选路径的
 * 拼接顺序、环境变量缺失时的降级、非 Windows 平台返回空候选、git.exe
 * 各安装形态的根目录推导、where 输出按行拆分与空白清理。文件系统、注册表
 * 与子进程 IO 由 resolveBashShellPath 内部承担，不在本文件的覆盖范围。
 */
import { describe, expect, it } from 'vitest'
import {
  bashCandidatesFromGitRoot,
  collectFixedBashCandidates,
  collectGitDerivedBashCandidates,
  gitRootFromGitExePath,
  parseWhereOutput,
  type IBashProbeEnvironment,
} from '../../src/application/bash-shell-check'

/** 构造指定平台与环境变量的探测环境（未传的环境变量视为缺失）。 */
function probeEnvironment(
  overrides: Partial<IBashProbeEnvironment> = {},
): IBashProbeEnvironment {
  return {
    platform: 'win32',
    programFiles: 'C:\\Program Files',
    programFilesX86: 'C:\\Program Files (x86)',
    ...overrides,
  }
}

describe('collectFixedBashCandidates', () => {
  it('Windows 下按 pi-agent-core 的探测顺序拼接固定候选', () => {
    const candidates = collectFixedBashCandidates(probeEnvironment())

    expect(candidates).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ])
  })

  it('环境变量缺失时跳过对应候选而不是拼出无效路径', () => {
    const candidates = collectFixedBashCandidates(
      probeEnvironment({ programFilesX86: undefined }),
    )

    expect(candidates).toEqual(['C:\\Program Files\\Git\\bin\\bash.exe'])
  })

  it('两个环境变量都缺失时返回空候选', () => {
    const candidates = collectFixedBashCandidates(
      probeEnvironment({ programFiles: undefined, programFilesX86: undefined }),
    )

    expect(candidates).toEqual([])
  })

  it('非 Windows 平台返回空候选（由 NodeExecutionEnv 自行探测）', () => {
    const candidates = collectFixedBashCandidates(
      probeEnvironment({ platform: 'linux' }),
    )

    expect(candidates).toEqual([])
  })
})

describe('bashCandidatesFromGitRoot', () => {
  it('由 Git 安装根推导 usr/bin 与 bin 两个 bash 候选', () => {
    expect(bashCandidatesFromGitRoot('D:\\soft\\Git')).toEqual([
      'D:\\soft\\Git\\usr\\bin\\bash.exe',
      'D:\\soft\\Git\\bin\\bash.exe',
    ])
  })

  it('正斜杠与尾部斜杠会被归一', () => {
    expect(bashCandidatesFromGitRoot('D:/soft/Git/')).toEqual([
      'D:\\soft\\Git\\usr\\bin\\bash.exe',
      'D:\\soft\\Git\\bin\\bash.exe',
    ])
  })

  it('空值或空白根目录返回空候选', () => {
    expect(bashCandidatesFromGitRoot(undefined)).toEqual([])
    expect(bashCandidatesFromGitRoot('   ')).toEqual([])
  })
})

describe('gitRootFromGitExePath', () => {
  it('识别 cmd wrapper 形态（安装时勾选加入 PATH）', () => {
    expect(gitRootFromGitExePath('D:\\soft\\Git\\cmd\\git.exe')).toBe(
      'D:\\soft\\Git',
    )
  })

  it('识别 mingw64/bin 形态（Git Bash 内部 PATH）', () => {
    expect(gitRootFromGitExePath('D:\\soft\\Git\\mingw64\\bin\\git.exe')).toBe(
      'D:\\soft\\Git',
    )
  })

  it('识别 mingw32/bin 形态', () => {
    expect(gitRootFromGitExePath('C:\\Git\\mingw32\\bin\\git.exe')).toBe(
      'C:\\Git',
    )
  })

  it('识别 bin 形态且大小写不敏感', () => {
    expect(gitRootFromGitExePath('C:\\Program Files\\GIT\\Bin\\git.exe')).toBe(
      'C:\\Program Files\\GIT',
    )
  })

  it('正斜杠输入会被归一后识别', () => {
    expect(gitRootFromGitExePath('D:/soft/Git/cmd/git.exe')).toBe(
      'D:\\soft\\Git',
    )
  })

  it('无法识别的形态返回 undefined', () => {
    expect(
      gitRootFromGitExePath('D:\\tools\\portable\\git.exe'),
    ).toBeUndefined()
  })
})

describe('collectGitDerivedBashCandidates', () => {
  it('把多个 git.exe 位置转换为去重后的 bash 候选（保持顺序）', () => {
    const candidates = collectGitDerivedBashCandidates([
      'D:\\soft\\Git\\mingw64\\bin\\git.exe',
      'D:\\soft\\Git\\cmd\\git.exe',
    ])

    // 两个 git.exe 同属一个安装根：候选去重后不重复。
    expect(candidates).toEqual([
      'D:\\soft\\Git\\usr\\bin\\bash.exe',
      'D:\\soft\\Git\\bin\\bash.exe',
    ])
  })

  it('无法识别的 git.exe 位置被跳过', () => {
    const candidates = collectGitDerivedBashCandidates([
      'D:\\tools\\portable\\git.exe',
    ])

    expect(candidates).toEqual([])
  })
})

describe('parseWhereOutput', () => {
  it('按行拆分 where 输出并保留原始顺序', () => {
    const paths = parseWhereOutput(
      'C:\\Windows\\System32\\bash.exe\r\nD:\\tools\\Git\\bin\\bash.exe\n',
    )

    expect(paths).toEqual([
      'C:\\Windows\\System32\\bash.exe',
      'D:\\tools\\Git\\bin\\bash.exe',
    ])
  })

  it('跳过空白行并清理首尾空白', () => {
    const paths = parseWhereOutput('  \r\nC:\\Git\\bin\\bash.exe  \n\n')

    expect(paths).toEqual(['C:\\Git\\bin\\bash.exe'])
  })

  it('空输出返回空数组', () => {
    expect(parseWhereOutput('')).toEqual([])
  })
})
