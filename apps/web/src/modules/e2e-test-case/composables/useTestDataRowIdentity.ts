/**
 * 为测试数据的键值对维护稳定的行标识（_id）。
 *
 * 测试数据在用例中持久化为 Record<string, string>，键名可被用户逐字符编辑，
 * 因此键名和数组下标都不适合作为 v-for 的 key：键名变化会重建 DOM 使输入框
 * 丢失焦点，下标则在删除条目后改变含义。本模块只负责标识的生命周期，
 * 不参与测试数据的读写，标识也不会写入用例数据。
 */
import { computed, type ComputedRef } from 'vue'

/** 测试数据行的渲染模型：持久化键值对加上仅用于渲染的稳定标识。 */
export interface ITestDataRow {
  /** 行稳定标识，仅用作 v-for 的 key。 */
  _id: string
  /** 数据键名，对应 testData 的对象键。 */
  label: string
  /** 数据值，对应 testData 的对象值。 */
  value: string
}

/** 行标识自增序号；模块级以保证同一会话内不与其他行冲突。 */
let rowIdSeed = 0

/**
 * 生成新的行标识。
 * @returns 形如 test_data_row_1 的唯一标识。
 * @throws 不抛出异常。
 */
function createRowId(): string {
  rowIdSeed += 1
  return `test_data_row_${rowIdSeed}`
}

/**
 * 创建测试数据行的稳定标识管理器。
 *
 * 标识以键名为锚点：键名不变则标识不变。键名被重命名时必须调用 transferRowId
 * 迁移标识，否则该行会被视为新行而重建 DOM。
 * @param readTestData 读取当前键值对记录的函数，通常传入 () => props.step.testData。
 * @returns rows 为带稳定标识的渲染行列表；transferRowId 在键名变更时迁移标识。
 * @throws 不抛出异常。
 */
export function useTestDataRowIdentity(
  readTestData: () => Record<string, string>,
): {
  rows: ComputedRef<ITestDataRow[]>
  transferRowId: (previousLabel: string, nextLabel: string) => void
} {
  /** 键名 → 稳定标识；随每次求值与被删除的键名对齐，避免长期编辑后无限增长。 */
  const rowIds = new Map<string, string>()

  const rows = computed<ITestDataRow[]>(() => {
    const entries = Object.entries(readTestData())
    const currentLabels = new Set(entries.map(([label]) => label))

    // 清理已不存在的键名，使标识集合与当前数据保持一致
    for (const label of [...rowIds.keys()]) {
      if (!currentLabels.has(label)) rowIds.delete(label)
    }

    // 已有键名复用原标识以保持行身份稳定，新增键名分配新标识
    return entries.map(([label, value]) => {
      const existing = rowIds.get(label)

      if (existing !== undefined) {
        return { _id: existing, label, value }
      }

      const id = createRowId()
      rowIds.set(label, id)
      return { _id: id, label, value }
    })
  })

  /**
   * 在键名变更时把稳定标识迁移到新键名，使该行不会被当作新行重建。
   * @param previousLabel 变更前的键名。
   * @param nextLabel 变更后的键名。
   * @returns 无返回值。
   * @throws 不抛出异常。
   */
  function transferRowId(previousLabel: string, nextLabel: string): void {
    const id = rowIds.get(previousLabel)

    if (id === undefined) {
      return
    }

    rowIds.delete(previousLabel)
    rowIds.set(nextLabel, id)
  }

  return { rows, transferRowId }
}
