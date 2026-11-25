/**
 * 工作项完成提示的唯一发布者（v13 PRD N 组、技术方案 §3.9.3）。
 *
 * 为什么需要这个中间层：完成提示有两个来源（执行的全局通知、生成的阶段终态），
 * 而两条**发布前的判定**对两者是同一套逻辑：
 *   1. 工作台展开时不提示（N-2）——用户已经在看结果，再弹一条是噪音；
 *   2. 同一工作项的同一终态只提示一次（N-8）——重复触发不产生第二条。
 * 若把这两条写在各自的来源里，两处迟早分叉。
 *
 * 用法：在应用外壳组件内调用一次并保留返回值（它持有去重表），随终态变化发布。
 */
import {
  useGlobalNotice,
  type IGlobalNotice,
  type IGlobalNoticeInput,
} from './useGlobalNotice'
import type { IWorkbenchSubject } from '../stores/global-chat'

/** 完成提示的三态（PRD N-5）。 */
export type TWorkbenchNoticeKind = 'success' | 'warning' | 'error'

/** 发布一条完成提示的输入。 */
export interface IPublishNoticeInput {
  /** 已完成的工作项主体；为空（如 `/agent` 发起的任务）时不发布（N-9）。 */
  subject: IWorkbenchSubject | null
  /** 提示样式。 */
  kind: TWorkbenchNoticeKind
  /** 通知内容（标题须指明任务名与结果，N-6）。 */
  notice: IGlobalNoticeInput
  /**
   * 本次终态的去重键。
   *
   * 同一工作项的同一终态必须产生同一个键；不同终态（如失败后重试再失败）
   * 必须是不同的键，否则第二次真实结束会被误判为重复。
   */
  dedupeKey: string
}

/** 完成提示发布器。 */
export interface IWorkbenchNoticePublisher {
  /**
   * 发布一条完成提示。
   *
   * @param input - 见 `IPublishNoticeInput`。
   * @returns 实际发出提示时返回 true；因工作台展开、缺主体或重复而被跳过时返回 false。
   * @throws 不抛出异常。
   */
  publish: (input: IPublishNoticeInput) => boolean
  /**
   * 清空去重表（工作台内容被清空时调用）。
   *
   * 不清空的话，清空后再次跑到相同终态的键会被误判为「已提示过」。
   *
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  forgetAll: () => void
}

/** 已提示过的终态键上限（防止长会话无限增长）。 */
const MAX_SEEN_KEYS = 100

/**
 * 创建完成提示发布器。
 *
 * @param isWorkbenchVisible - 读取工作台是否展开（由调用方注入，便于单测）。
 * @returns 发布器实例。
 * @throws 不抛出异常。
 */
export function createWorkbenchNoticePublisher(
  isWorkbenchVisible: () => boolean,
): IWorkbenchNoticePublisher {
  const notice: IGlobalNotice = useGlobalNotice()
  /** 已提示过的终态键（按插入顺序淘汰最旧的）。 */
  const seen = new Set<string>()

  /**
   * 记住一个终态键；超过上限时淘汰最旧的。
   *
   * @param key - 终态去重键。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function remember(key: string): void {
    seen.add(key)
    if (seen.size > MAX_SEEN_KEYS) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
  }

  return {
    publish(input) {
      // 工作台展开时不提示（N-2）：用户已在看终态呈现。
      if (isWorkbenchVisible()) return false
      // 不属于本工作台的任务不提示（N-9，`/agent` 的任务由该页自行呈现）。
      if (!input.subject) return false
      // 同一终态只提示一次（N-8）。
      if (seen.has(input.dedupeKey)) return false

      remember(input.dedupeKey)
      if (input.kind === 'success') notice.success(input.notice)
      else if (input.kind === 'warning') notice.warning(input.notice)
      else notice.error(input.notice)
      return true
    },

    forgetAll() {
      seen.clear()
    },
  }
}
