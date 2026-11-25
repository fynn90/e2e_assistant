/**
 * userWorkSpace 相对路径的共享校验与归一化（v14，技术方案 §3.5）。
 *
 * 单一职责：纯函数校验「用户输入 / Agent 选项值」是否可解释为当前 Skill
 * userWorkSpace 内的安全相对路径，并给出归一化结果。供三端共用，避免多端漂移：
 *   - Web：AskUserQuestion「其它」自定义输入的即时校验、文件树新建入口校验；
 *   - CLI：ask host 回答归一化的兜底校验；
 *   - skill-manager：file-create / 存在性检查的入口归一化（再叠加 realpath 检查）。
 *
 * 段级校验规则与 skill-manager 的 `normalizeRelativePath` 保持同源语义
 * （拒绝空、'..'、'.'、反斜杠、盘符、UNC、空字节、超长），但**不抛异常**：
 * 前端需要「非法时即时提示」而不是异常流，因此返回 undefined 表达失败。
 */

/**
 * userWorkSpace 目录的固定名称（v14，PRD 4.1/W2）。
 *
 * 路径恒为 `<skillRoot>/userWorkSpace/`，大小写不可更改；归一化判定
 * （剥离前导段）按小写比较以覆盖 Windows 大小写不敏感文件系统的变体。
 */
export const USER_WORKSPACE_DIRECTORY_NAME = 'userWorkSpace'

/**
 * 平台内置环境变量（v14 W38）：执行期由平台注入测试子进程，不需要在
 * e2e_schema.json 的业务测试数据中声明，也不允许业务在 env.json 中占用。
 */
export const PLATFORM_BUILTIN_ENV_KEYS: readonly string[] = [
  'SKILL_USER_WORKSPACE',
]

/** 相对路径的最大长度（与 skill-manager 的 MAX_RELATIVE_PATH_LENGTH 同值）。 */
const MAX_RELATIVE_PATH_LENGTH = 2048

/** URL 编码绕过检测：句点、正反斜杠与空字节的编码形态。 */
const URL_ENCODED_TRAVERSAL_PATTERN = /%(?:2e|2f|5c|00)/i

/**
 * 校验并归一化 userWorkSpace 内相对路径（v14 D2 规则）。
 *
 * 归一化只有一条规则：**相对 userWorkSpace 解析 + 剥离一次前导 `userWorkSpace` 段**。
 * 例：`preview` → `preview`；`baselines/preview` → `baselines/preview`（前导
 * `baselines/` 不剥离）；`userWorkSpace/preview` → `preview`（剥离一次前导段）。
 *
 * @param input 用户或 Agent 给出的原始路径文本。
 * @returns POSIX 分隔的 userWorkSpace 内相对路径；非法时返回 undefined（不抛出）。
 * @throws 不抛出异常——失败以 undefined 表达，便于前端即时提示。
 */
export function normalizeUserWorkspaceRelativePath(
  input: string,
): string | undefined {
  if (typeof input !== 'string') return undefined

  const trimmed = input.trim()
  if (
    !trimmed ||
    trimmed.length > MAX_RELATIVE_PATH_LENGTH ||
    trimmed.includes('\0')
  ) {
    return undefined
  }

  // 拒绝绝对路径（POSIX / Windows）、盘符、UNC 与反斜杠。
  if (
    trimmed.startsWith('/') ||
    /^[a-zA-Z]:/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    /^\\\\[?.]\\/.test(trimmed) ||
    trimmed.includes('\\')
  ) {
    return undefined
  }

  // 拒绝 URL 编码形态的穿越字符（%2e/%2f/%5c/%00）。
  if (URL_ENCODED_TRAVERSAL_PATTERN.test(trimmed)) {
    return undefined
  }

  const segments = trimmed.split('/')
  const workspaceNameLower = USER_WORKSPACE_DIRECTORY_NAME.toLowerCase()

  // 剥离一次前导 'userWorkSpace' 段（大小写不敏感，覆盖 Windows 变体）。
  let offset = 0
  if (segments[0]?.toLowerCase() === workspaceNameLower) {
    offset = 1
  }

  const inner = segments.slice(offset)

  // 输入只有 'userWorkSpace' 本身：剥离后为空 → 拒绝（不能指向根目录自身）。
  if (inner.length === 0) return undefined

  // 段级规则：非空、非 '.'、非 '..'、不含冒号与空字节。
  // 再次出现的 'userWorkSpace' 段（userWorkSpace/userWorkSpace/x）同样拒绝（A16）。
  for (const segment of inner) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      segment.includes(':') ||
      segment.includes('\0') ||
      segment.toLowerCase() === workspaceNameLower
    ) {
      return undefined
    }
  }

  return inner.join('/')
}
