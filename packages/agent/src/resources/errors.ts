/**
 * 资源加载器相关的错误类型。
 *
 * 统一抛错，便于调用方按错误类型做差异化处理（例如资源缺失时提示可用清单）。
 */

import type { ResourceType } from './types'

/** 资源加载错误基类 */
export class ResourceError extends Error {
  /**
   * @param message - 错误描述
   */
  constructor(message: string) {
    super(message)
    this.name = 'ResourceError'
  }
}

/** 目标资源不存在 */
export class ResourceNotFoundError extends ResourceError {
  /**
   * @param type - 资源类型
   * @param name - 资源文件名
   * @param available - 当前可用的资源名清单（用于错误提示）
   */
  constructor(type: ResourceType, name: string, available: string[]) {
    const hint =
      available.length > 0
        ? `可用资源: ${available.join(', ')}`
        : '暂无可用资源'
    super(`未找到 ${type} 资源 "${name}"。${hint}`)
    this.name = 'ResourceNotFoundError'
  }
}

/** 资源内容解析失败（frontmatter 缺失 / 模块导出非法） */
export class ResourceParseError extends ResourceError {
  /**
   * @param type - 资源类型
   * @param name - 资源文件名
   * @param reason - 解析失败的具体原因
   */
  constructor(type: ResourceType, name: string, reason: string) {
    super(`解析 ${type} 资源 "${name}" 失败: ${reason}`)
    this.name = 'ResourceParseError'
  }
}
