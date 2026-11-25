/**
 * 空态建议问题（v17 H1）。
 *
 * ## 为什么在服务端生成而不是前端写死
 *
 * 建议问题的价值全在「贴当前工作区的现状」（H1：有失败的提示看失败、缺产物的
 * 提示盘点缺口）。前端要算出来得把「哪些用例缺文档 / 缺脚本 / 最近失败」
 * 全拉一遍——那正是服务端已有的检索能力；放在服务端还能覆盖工作区为空的
 * 退化情形（H1 末句），前端不必分两套逻辑。
 *
 * ## 退化顺序（H1）
 *
 *   有最近失败 → 「看看最近失败的用例」
 *   有缺产物的 → 「哪些用例还没生成脚本」
 *   有产物齐备的 → 「跑一下 <某用例标题>」
 *   工作区为空 → 「创建一个测试用例」+「你能做什么」
 *   检索失败 → 通用示例（不报错——建议问题不该让空态变成错误页）
 */

import type { ISkillCatalog } from './skill-catalog'

/** 建议问题的条数区间（H1：3–4 个）。 */
const MIN_SUGGESTIONS = 3
const MAX_SUGGESTIONS = 4

/** 检索失败或工作区状态不可判断时的通用示例（H1 的兜底）。 */
const GENERIC_SUGGESTIONS = [
  '我有哪些测试用例？',
  '你能做什么？',
  '创建一个测试用例',
  '看看最近失败的用例',
]

/** 建议问题服务接口。 */
export interface ISuggestionService {
  /**
   * 生成当前工作区的空态建议问题。
   *
   * @param input.rootDir - 工作区根目录。
   * @returns 3–4 条建议问题；检索失败时返回通用示例（不抛错）。
   * @throws 不抛出异常。
   */
  suggest(input: { rootDir: string }): Promise<string[]>
}

/**
 * 创建建议问题服务。
 *
 * @param dependencies - 检索服务（与卡片/工具共用同一实例，判定同源）。
 * @returns 建议问题服务实例。
 * @throws 不抛出异常。
 */
export function createSuggestionService(dependencies: {
  catalog: ISkillCatalog
}): ISuggestionService {
  return {
    async suggest({ rootDir }) {
      try {
        return await buildSuggestions(dependencies.catalog, rootDir)
      } catch {
        // 检索失败不该让空态变成错误页（H1 末句）：退回通用示例。
        return [...GENERIC_SUGGESTIONS]
      }
    },
  }
}

/**
 * 按工作区现状组装建议问题。
 *
 * @param catalog - 检索服务。
 * @param rootDir - 工作区根目录。
 * @returns 3–4 条建议问题。
 * @throws 不抛出异常——检索失败由调用方兜底。
 */
async function buildSuggestions(
  catalog: ISkillCatalog,
  rootDir: string,
): Promise<string[]> {
  const candidates = await catalog.listCandidates(rootDir)

  // 工作区为空：退回「创建一个测试用例」+「你能做什么」（H1 明确要求）。
  if (candidates.length === 0) {
    return ['创建一个测试用例', '你能做什么？', '这个页面能帮我做什么？']
  }

  const suggestions: string[] = []

  // ① 有最近失败的用例 → 提示查看失败（最贴合「我现在想干什么」）。
  const failed = await catalog.listFiltered(rootDir, { status: 'last-failed' })
  if (failed.total > 0) {
    suggestions.push('看看最近失败的用例')
  }

  // ② 有缺产物的 → 提示盘点缺口。
  const missingScript = await catalog.listFiltered(rootDir, {
    status: 'missing-script',
  })
  if (missingScript.total > 0) {
    suggestions.push('哪些用例还没生成脚本')
  } else {
    const missingDocument = await catalog.listFiltered(rootDir, {
      status: 'missing-document',
    })
    if (missingDocument.total > 0) {
      suggestions.push('哪些用例还没生成文档')
    }
  }

  // ③ 有产物齐备的 → 提示跑一个（用真实标题，比「跑个用例」有用得多）。
  const runnable = candidates.find(
    (candidate) => candidate.hasSkillDocument && candidate.hasPlaywrightScript,
  )
  if (runnable) {
    suggestions.push(`跑一下「${runnable.title}」`)
  }

  // ④ 通用兜底：任何情况下都可问的。
  if (suggestions.length < MIN_SUGGESTIONS) {
    suggestions.push('我有哪些用例？')
  }
  if (suggestions.length < MIN_SUGGESTIONS) {
    suggestions.push('你能做什么？')
  }

  // 去重后截到上限：不同状态可能命中同一条，重复的 chips 是噪音。
  return [...new Set(suggestions)].slice(0, MAX_SUGGESTIONS)
}
