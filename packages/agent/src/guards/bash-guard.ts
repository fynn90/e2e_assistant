/**
 * bash 危险命令清单与静态判定（v11，技术方案 D11 / §5.4）。
 *
 * bash 工具放开后（生成守卫白名单与 Skill Chat）共用本模块：
 * 命中清单的命令**拒绝执行**但不终止会话轮次——Agent 可调整方式重试。
 * 清单为命令文本的静态匹配，变量拼接 / 编码混淆存在理论绕过面（R4），
 * 以提示词约束叠加（composeSystemPrompt 的「bash 可用但危险清单命令会被拒绝」），
 * 结构性沙箱留后续版本。
 *
 * 目录约定：`src/tools/` 只保存可直接被 Agent 调用的工具对象；
 * 本模块是守卫类纯函数，故置于 `src/guards/`。
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, win32 } from 'node:path'

/**
 * 危险命令模式清单（首批；大小写不敏感，按整条命令文本匹配）。
 *
 * 维护约定：只在此单点更新（bash-guard 是生成守卫与 Chat 工具的共同来源），
 * 并在 packages/agent 的 README「危险命令清单」小节同步说明。
 */
export const BASH_DANGEROUS_PATTERNS: readonly RegExp[] = [
  // —— 递归强制删除：rm -rf / rm -fr / rm -r 作用于根、家目录、盘根或顶层通配 ——
  /\brm\s+(-[a-z]*[rf][a-z]*\s+){1,}(-[a-z]*[rf][a-z]*\s+)*("\/"|\*|~|\/\*|[a-z]:[\\/]\*?)/i,
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(-[a-z]+\s+)*\S*/i,
  /\brd\s+\/s\s+\/q/i,
  /\bdel\s+\/f\s+\/s\s+\/q/i,
  // —— 磁盘与系统 ——
  /\bmkfs\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bdd\s+if\s*=/i,
  // —— 注册表与权限 ——
  /\breg\s+(add|delete)\b/i,
  /\bchmod\s+777\b/i,
  // —— 远程代码执行 ——
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
  /\biex\b/i,
  /\binvoke-expression\b/i,
  /\binvoke-webrequest\b[^|]*\|\s*iex\b/i,
  // —— 计划任务与服务 ——
  /\bschtasks\s+\/create\b/i,
  /\bsc\s+config\b/i,
]

/**
 * 引用 env.json 的危险访问模式（A3 的 bash 侧拦截）：
 * 任何把 env.json 作为读写对象的常见命令文本。
 */
const ENV_FILE_ACCESS_PATTERN =
  /\b(cat|type|more|less|head|tail|rm|mv|cp|touch|nano|vim|vi|echo|tee)\b[^;&|]*\benv\.json\b/i

/**
 * 平台维护文件（禁止写入）的文件名，与 CLI 侧 `PROTECTED_WRITE_FILE_NAMES` 同源。
 *
 * 为什么在 agent 包内再声明一份而不是 import CLI 的清单：依赖方向是
 * CLI → agent，反向 import 会形成循环依赖。本清单是**纯文件名常量**，
 * 漂移风险由两侧的单元测试同时锁定（各自的测试都断言清单内容）。
 */
const PROTECTED_WRITE_FILE_PATTERN =
  '(manifest\\.json|e2e_schema\\.json|skill\\.list\\.json)'

/**
 * 受保护文件的写入模式（v16 §6.2.1 动作①）。
 *
 * 覆盖两类常见写法：
 *   ① 写入类命令把受保护文件当目标（`rm` / `mv` / `cp` / `tee` / `sed -i` / `truncate` / `dd`）；
 *   ② 重定向把内容写进受保护文件（`>` / `>>`，无论操作符在哪一侧——
 *      `echo x > manifest.json` 与 `cat manifest.json > x` 的**前者**是写入，
 *      后者只是读，所以重定向分支要求操作符与文件名之间没有其他重定向目标）。
 *
 * 与上方 env.json 的处理分开表达：env.json 是**读写都**拦（A3 的结构性要求），
 * 平台维护文件是**只拦写**（读是允许的，PRD SEC-1②）。
 */
const PROTECTED_FILE_WRITE_PATTERN = new RegExp(
  [
    // ① 写入类命令 + 受保护文件（命令与目标之间不得有管道：管道后是另一个命令）
    `\\b(rm|mv|cp|tee|truncate|sed\\s+-i|perl\\s+-i|dd)\\b[^;&|]*${PROTECTED_WRITE_FILE_PATTERN}\\b`,
    // ② 重定向直接以受保护文件为目标（操作符紧邻文件名）
    `>>?\\s*${PROTECTED_WRITE_FILE_PATTERN}\\b`,
    // ③ 文本写入命令把受保护文件当**写入目标**：命令与文件名之间只有一个重定向操作符
    //    （`echo x > manifest.json`）或文件名后紧跟重定向（`cat x >> manifest.json`）。
    //    刻意不写成「文件名 + 任意内容 + 重定向」——那会把 `cat manifest.json | jq .`
    //    这类**读**误判为写（管道不是重定向）。
    `\\b(echo|printf|cat)\\b[^;&|]*>>?\\s*${PROTECTED_WRITE_FILE_PATTERN}\\b`,
    `\\b(echo|printf)\\b[^;&|]*${PROTECTED_WRITE_FILE_PATTERN}\\s*>>?`,
  ].join('|'),
  'i',
)

/**
 * 命令文本中出现的**绝对路径字面量**（v16 §6.2.1 动作②）。
 *
 * 只覆盖能看见字面量的写法：家目录简写、`$HOME`、`%USERPROFILE%`、盘符路径。
 * `cd` 到别处后再操作、变量拼接、编码混淆看不到字面量，属已知绕过面（PRD R12），
 * 由提示词明示边界共同收紧，不在此假装覆盖。
 *
 * 捕获组 2 是完整的路径 token（含后续的非空白字符），供展开后判定是否在工作区内。
 */
const ABSOLUTE_PATH_LITERAL_PATTERN =
  /(^|[\s"'=(])((?:~[\\/]|\$HOME\b|\$\{HOME\}|%USERPROFILE%|[a-z]:[\\/])[^\s"'`;&|)]*)/gi

/**
 * 判断命令中的路径字面量是否指向工作区之外。
 *
 * 为什么需要 workspace 参与判定：盘符路径在 Windows 上既可能是越界的
 * `C:\Users\...\.ssh\id_rsa`，也可能是**工作区自己的**绝对路径
 * （`D:\my-ws\case\SKILL.md`）。只按「像盘符」一刀切会把后者也拦下——
 * Agent 被要求在工作区内工作，却因为写出工作区的绝对路径而被拒绝，
 * 属于误伤（PRD SEC-1a 要拦的是「工作区之外」，不是「绝对路径」）。
 *
 * 强度如实说明：这仍是**命令文本的静态判定**，逐字面量展开后比对，
 * 覆盖不到变量拼接与编码混淆（PRD R12 的已知绕过面）。
 *
 * @param command - 待判定的命令文本。
 * @param workspace - 工作区绝对路径；未提供时对任何绝对路径字面量一律判为越界
 *   （缺少比对基准时取保守方向）。
 * @returns 存在指向工作区之外的字面量时返回 true。
 * @throws 不抛出异常（路径解析失败按越界处理）。
 */
function hasOutsideWorkspaceLiteral(
  command: string,
  workspace: string | undefined,
): boolean {
  ABSOLUTE_PATH_LITERAL_PATTERN.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = ABSOLUTE_PATH_LITERAL_PATTERN.exec(command)) !== null) {
    const literal = match[2]
    if (!literal) continue

    // 无比对基准：保守判为越界（保持未传 workspace 时的既有强度）。
    if (!workspace) return true

    if (!isLiteralInsideWorkspace(literal, workspace)) return true
  }

  return false
}

/**
 * 把单个路径字面量展开为绝对路径，并判断是否落在工作区内。
 *
 * @param literal - 命令中出现的路径字面量（如 `~/a.txt`、`D:\ws\x`）。
 * @param workspace - 工作区绝对路径。
 * @returns 该字面量位于工作区内时返回 true。
 * @throws 不抛出异常（展开或解析失败按「不在工作区内」处理）。
 */
function isLiteralInsideWorkspace(
  literal: string,
  workspace: string,
): boolean {
  try {
    // 盘符路径用 win32 语义比对：其形状与平台无关，若当前运行在 POSIX 上，
    // 它与工作区必然不在同一命名空间，按越界处理（保守且符合事实）。
    if (/^[a-z]:[\\/]/i.test(literal)) {
      if (process.platform !== 'win32') return false
      const target = win32.resolve(literal)
      const root = win32.resolve(workspace)
      const rel = win32.relative(root, target)
      return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel))
    }

    // 家目录简写与 Windows 环境变量：展开为当前用户的 home。
    const expanded = literal
      .replace(/^~(?=[\\/])/, homedir())
      .replace(/^\$\{?HOME\}?(?=[\\/])/, homedir())
      .replace(/^%USERPROFILE%(?=[\\/])/i, homedir())

    const target = resolve(workspace, expanded)
    const rel = relative(workspace, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}

/**
 * 判定一条 bash 命令是否命中危险清单。
 *
 * 覆盖三层：通用危险命令、env.json 访问、受保护文件的写入与工作区外访问（v16）。
 * 这是**命令文本的静态判定**，变量拼接 / 编码混淆存在理论绕过面（v11 R4 / v16 R12），
 * 因此边界强度为「尽力而为」，须与结构性强制（read/write/edit 守卫）区分表述。
 *
 * @param command - 待判定的命令文本。
 * @param workspace - 工作区绝对路径（可选）。提供后，命令里的**工作区内**绝对路径
 *   不再被判为越界访问；缺省时保持原有的严格口径（任何绝对路径字面量都拒绝）。
 * @returns 命中清单时返回 true（调用方应拒绝执行）；空白命令视为危险（无法判定即拒绝）。
 * @throws 不抛出异常。
 */
export function isDangerousBashCommand(
  command: string,
  workspace?: string,
): boolean {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return true
  }

  for (const pattern of BASH_DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return true
    }
  }

  // A3：env.json 的值不允许以任何方式进入 Agent 上下文，bash 读引用同样拒绝。
  if (ENV_FILE_ACCESS_PATTERN.test(command)) {
    return true
  }

  // v16：平台维护文件只拦写（读允许），与 read/write 守卫的清单保持一致。
  if (PROTECTED_FILE_WRITE_PATTERN.test(command)) {
    return true
  }

  // v16：工作区外访问的字面量目标（尽力而为，见上方注释）。
  if (hasOutsideWorkspaceLiteral(command, workspace)) {
    return true
  }

  return false
}
