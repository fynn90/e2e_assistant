/**
 * 路径与文件名的安全判定纯函数（v16）：工作区边界、敏感文件、平台维护文件。
 *
 * 为什么独立成模块：生成任务的守卫（`createGenerationWriteGuard`）与
 * Agent 工作台守卫（`createAgentWorkbenchGuard`）的**判定依据**是同一份
 * ——「路径归一后是否位于工作区内」「是否命中值级敏感文件」——但两者的
 * **处置策略**不同（生成守卫只允许写唯一目标文件；工作台守卫允许写工作区内
 * 的多个文件）。把判定抽到这里、策略留在各自的守卫里，避免两处各写一份
 * 判定函数而逐渐分叉（开闭原则：新增守卫只需声明自己的策略）。
 *
 * 本模块只做纯字符串/路径运算，不触盘、不抛异常。
 */

import { basename, isAbsolute, relative, resolve } from 'node:path'
import { SKILL_ENV_FILE_NAME } from '@authine-e2e-agent/skill-manager'

/**
 * 禁止 Agent 读取的值级敏感文件名清单（小写）。
 *
 * `env.json` 保存敏感数据真实值，任何会话（生成任务、Agent 工作台）
 * 都不需要读到值——用例数据中的 `${ENV:KEY}` 引用已足够。这是结构性安全保证，
 * 不依赖提示词自觉。
 */
export const BLOCKED_READ_FILE_NAMES: ReadonlySet<string> = new Set([
  SKILL_ENV_FILE_NAME.toLowerCase(),
])

/**
 * 禁止 Agent 写入（创建 / 修改 / 删除）的平台维护文件名清单（小写）。
 *
 * 三者的共同点：都是平台维护的元数据，由专门链路写入——
 *   - `manifest.json`：Skill 身份与来源元数据（仓储 `save()` 提交）；
 *   - `e2e_schema.json`：结构化用例的唯一数据源（用例编辑页保存）；
 *   - `skill.list.json`：全局索引（skill-manager 维护）。
 *
 * Agent 直接改写它们会绕过仓储的版本校验与来源哈希，因此结构性拒绝。
 * `env.json` 已在 {@link BLOCKED_READ_FILE_NAMES} 中禁读，此处一并禁写。
 */
export const PROTECTED_WRITE_FILE_NAMES: ReadonlySet<string> = new Set([
  SKILL_ENV_FILE_NAME.toLowerCase(),
  'manifest.json',
  'e2e_schema.json',
  'skill.list.json',
])

/**
 * 判断请求路径是否落在工作区内。
 *
 * 相对路径按工作区解析；绝对路径直接使用。判定采用**路径归一后比较**：
 * 工作区之外的结果一定是 `..` 开头或本身就是另一个绝对路径。
 *
 * 局限（如实记录）：符号链接不做真实路径解析，指向工作区外的链接会通过本判定。
 * 与 v14/v15 的既有取舍一致（执行期 fs 拦截不在本版范围内）。
 *
 * @param workspace - 已解析的工作区根目录绝对路径。
 * @param requestedPath - 模型给出的路径；非字符串或空白视为不合法。
 * @returns 路径位于工作区内（含工作区自身）时返回 true。
 * @throws 不抛出异常。
 */
export function isPathInsideWorkspace(
  workspace: string,
  requestedPath: unknown,
): boolean {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    return false
  }

  const resolvedPath = resolve(workspace, requestedPath)
  const relativePath = relative(workspace, resolvedPath)

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

/**
 * 判断请求路径是否命中指定的文件名清单。
 *
 * 以路径解析后的文件名（**大小写不敏感**）判定，覆盖 `env.json`、`ENV.JSON`
 * 等变体以及任意相对 / 绝对路径写法。
 *
 * @param workspace - 已解析的工作区根目录（相对路径据此解析）。
 * @param requestedPath - 模型给出的路径。
 * @param fileNames - 小写的文件名清单。
 * @returns 命中清单时返回 true。
 * @throws 不抛出异常。
 */
export function isPathWithFileNameIn(
  workspace: string,
  requestedPath: unknown,
  fileNames: ReadonlySet<string>,
): boolean {
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    return false
  }

  const requestedBasename = basename(resolve(workspace, requestedPath))
  return fileNames.has(requestedBasename.toLowerCase())
}
