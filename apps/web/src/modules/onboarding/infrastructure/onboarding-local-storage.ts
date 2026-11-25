/**
 * 提供按工作区隔离的首次激活引导本地持久化能力。
 */
import {
  normalizeOnboardingState,
  type IOnboardingStateV1,
} from '../domain/onboarding-state'

const ONBOARDING_STORAGE_PREFIX = 'authine.onboarding.v1:'

export interface IOnboardingStateRepository {
  load(workspaceDirectory: string): IOnboardingStateV1 | null
  save(state: IOnboardingStateV1): boolean
}

/**
 * 创建浏览器 localStorage 驱动的引导状态仓储。
 * @param storage 可选 Storage 实现，默认使用当前浏览器 localStorage。
 * @returns 可安全加载和保存引导状态的仓储。
 * @throws 不抛出异常，浏览器存储不可用时通过 null/false 降级。
 */
export function createOnboardingLocalStorageRepository(
  storage: Storage | null = resolveLocalStorage(),
): IOnboardingStateRepository {
  return {
    load(workspaceDirectory: string): IOnboardingStateV1 | null {
      if (!storage || !workspaceDirectory.trim()) {
        return null
      }

      try {
        const serialized = storage.getItem(
          buildOnboardingStorageKey(workspaceDirectory),
        )
        if (!serialized) {
          return null
        }

        return normalizeOnboardingState(
          JSON.parse(serialized),
          workspaceDirectory,
        )
      } catch {
        return null
      }
    },

    save(state: IOnboardingStateV1): boolean {
      if (!storage) {
        return false
      }

      try {
        storage.setItem(
          buildOnboardingStorageKey(state.workspaceDirectory),
          JSON.stringify(state),
        )
        return true
      } catch {
        return false
      }
    },
  }
}

/**
 * 构建按工作区目录隔离的引导状态存储键。
 * @param workspaceDirectory 工作区绝对目录。
 * @returns 经过 URI 编码的版本化存储键。
 * @throws 不抛出异常。
 */
export function buildOnboardingStorageKey(workspaceDirectory: string): string {
  return `${ONBOARDING_STORAGE_PREFIX}${encodeURIComponent(workspaceDirectory.trim())}`
}

/**
 * 安全读取浏览器 localStorage，兼容 SSR、隐私模式和安全策略限制。
 * @returns 可用的 Storage；不可用时返回 null。
 * @throws 不抛出异常。
 */
function resolveLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
