/**
 * 提供 E2E 用例草稿的深拷贝、稳定 ID、步骤插入复制删除和顺序标准化纯函数。
 */
import { toRaw } from 'vue'
import type {
  IE2EPrecondition,
  IE2ETestCase,
  IE2ETestStep,
} from '@fynn90-e2e_assistant/types'

/**
 * 深拷贝普通或 Vue 响应式代理形式的 E2E 用例草稿。
 * @param testCase 待复制的 E2E 用例。
 * @returns 与输入数据解耦的普通对象副本。
 * @throws 当输入包含结构化克隆不支持的数据时抛出 DataCloneError。
 */
export function cloneTestCaseDraft (testCase: IE2ETestCase): IE2ETestCase {
  return structuredClone(toRaw(testCase))
}

export function createPrecondition (): IE2EPrecondition {
  return { id: createStableId('pre'), description: '' }
}

export function createStep (order: number): IE2ETestStep {
  return {
    id: createStableId('step'),
    order,
    description: '',
    action: '',
    expectedResult: '',
    testData: {},
    enabled: true,
  }
}

export function normalizeStepOrder (steps: IE2ETestStep[]): IE2ETestStep[] {
  return steps.map((step, index) => ({ ...step, order: index + 1 }))
}

export function insertStepAfter (
  steps: IE2ETestStep[],
  index: number,
): IE2ETestStep[] {
  const next = [...steps]
  next.splice(index + 1, 0, createStep(index + 2))
  return normalizeStepOrder(next)
}

export function duplicateStep (
  steps: IE2ETestStep[],
  index: number,
): IE2ETestStep[] {
  const source = steps[index]

  if (!source) {
    return steps
  }

  const next = [...steps]
  next.splice(index + 1, 0, {
    ...structuredClone(toRaw(source)),
    id: createStableId('step'),
  })
  return normalizeStepOrder(next)
}

export function deleteStep (
  steps: IE2ETestStep[],
  index: number,
): IE2ETestStep[] {
  return normalizeStepOrder(steps.filter((_, itemIndex) => itemIndex !== index))
}

export function moveStep (
  steps: IE2ETestStep[],
  fromIndex: number,
  toIndex: number,
): IE2ETestStep[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= steps.length ||
    toIndex >= steps.length ||
    fromIndex === toIndex
  ) {
    return steps
  }

  const next = [...steps]
  const [step] = next.splice(fromIndex, 1)

  if (!step) {
    return steps
  }

  next.splice(toIndex, 0, step)
  return normalizeStepOrder(next)
}

function createStableId (prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`
}
