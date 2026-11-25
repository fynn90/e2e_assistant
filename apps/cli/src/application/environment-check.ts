import process from 'node:process'

const MINIMUM_SUPPORTED_NODE_VERSION = '22.19.0'

/**
 * Node 版本校验结果。
 *
 * 只返回、不打印：输出属于命令层职责（见 `message-line.ts`）。这样同一份判定
 * 也能被将来需要它的地方复用，而不必连终端格式一起搬走。
 */
export type TNodeVersionCheckResult =
  { satisfied: true } | { satisfied: false; message: string }

interface INodeVersionInfo {
  major: number
  minor: number
  patch: number
}

/**
 * 校验当前 Node.js 版本是否满足 CLI 的最低运行要求。
 *
 * 不打印：不满足时把说明随结果返回，由调用方决定写到哪个流、用什么格式。
 *
 * @returns 校验结果；不满足时在 `message` 里给出可执行的说明。
 * @throws 不抛出异常。
 */
export function checkNodeVersion (): TNodeVersionCheckResult {
  const currentNodeVersion = process.versions.node
  const currentVersionInfo = parseNodeVersion({
    versionText: currentNodeVersion,
  })
  const minimumVersionInfo = parseNodeVersion({
    versionText: MINIMUM_SUPPORTED_NODE_VERSION,
  })

  if (!currentVersionInfo || !minimumVersionInfo) {
    return {
      satisfied: false,
      message: `无法识别当前 Node.js 版本，请升级到 ${MINIMUM_SUPPORTED_NODE_VERSION} 或更高版本后重试。`,
    }
  }

  const isVersionSatisfied =
    compareNodeVersions({
      currentVersion: currentVersionInfo,
      minimumVersion: minimumVersionInfo,
    }) >= 0

  if (isVersionSatisfied) {
    return { satisfied: true }
  }

  return {
    satisfied: false,
    message: `当前 Node.js 版本为 ${currentNodeVersion}，Authine E2E Agent Platform 需要 Node.js ${MINIMUM_SUPPORTED_NODE_VERSION} 或更高版本。请先升级 Node.js 后再执行 e2e_assistant 命令。`,
  }
}

interface IParseNodeVersionOptions {
  versionText: string
}

/**
 * 解析 Node.js 版本字符串，提取主次补丁版本号。
 * @param options 版本解析参数。
 * @returns 解析成功时返回结构化版本信息，失败时返回 `null`。
 */
function parseNodeVersion (
  options: IParseNodeVersionOptions,
): INodeVersionInfo | null {
  const matchedVersionParts = options.versionText.match(
    /^v?(\d+)\.(\d+)\.(\d+)/,
  )

  if (!matchedVersionParts) {
    return null
  }

  return {
    major: Number(matchedVersionParts[1]),
    minor: Number(matchedVersionParts[2]),
    patch: Number(matchedVersionParts[3]),
  }
}

interface ICompareNodeVersionsOptions {
  currentVersion: INodeVersionInfo
  minimumVersion: INodeVersionInfo
}

/**
 * 比较当前版本与最低版本的大小关系。
 * @param options 版本比较参数。
 * @returns 当前版本更大返回正数，相等返回 `0`，更小返回负数。
 */
function compareNodeVersions (options: ICompareNodeVersionsOptions): number {
  const currentSegments = [
    options.currentVersion.major,
    options.currentVersion.minor,
    options.currentVersion.patch,
  ]
  const minimumSegments = [
    options.minimumVersion.major,
    options.minimumVersion.minor,
    options.minimumVersion.patch,
  ]

  for (let index = 0; index < currentSegments.length; index += 1) {
    if (currentSegments[index] !== minimumSegments[index]) {
      return currentSegments[index] - minimumSegments[index]
    }
  }

  return 0
}
