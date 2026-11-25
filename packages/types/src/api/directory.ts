/**
 * 定义目录选择器所需的文件系统浏览 API 类型，供本地 CLI 服务与 Web 工作台共享。
 */
import type { IApiSuccessResponse } from './common'

/**
 * 目录浏览结果中的单个子目录条目。
 *
 * 仅包含目录（不包含文件），因为目录选择器只需要在目录之间导航。
 */
export interface IDirectoryEntry {
  /** 目录名称（不包含路径）。 */
  name: string
  /** 规范化后的目录绝对路径，可直接提交给配置保存接口。 */
  absolutePath: string
  /** 是否为空目录；判定时忽略 .DS_Store 与 Thumbs.db 等系统文件。 */
  empty: boolean
  /** 是否可读取；为 false 时前端应禁止进入该目录。 */
  accessible: boolean
  /** 是否为符号链接（快捷方式）指向的目录。 */
  symbolicLink: boolean
}

/**
 * 单层目录浏览结果。
 *
 * 只返回当前目录的直接子目录，不做递归，因此不存在符号链接循环风险。
 */
export interface IDirectoryListing {
  /** 规范化后的当前目录绝对路径。 */
  currentPath: string
  /** 上一级目录绝对路径；当前已是文件系统根（如 D:\ 或 /）时为 null。 */
  parentPath: string | null
  /** 当前路径所在的文件系统根（如 'D:\' 或 '/'），供「回到盘符根」快捷跳转使用。 */
  rootPath: string
  /** 当前目录的子目录列表，仅目录、已按名称排序。 */
  directories: IDirectoryEntry[]
  /** 子目录列表是否因超过条目上限而被截断。 */
  truncated: boolean
  /** 当前目录自身是否为空目录。 */
  currentEmpty: boolean
  /** 当前目录自身是否可写；为 false 时保存配置将失败。 */
  currentWritable: boolean
}

/** 目录浏览起始位置集合，用于弹窗中的盘符或家目录快捷入口。 */
export interface IBrowseRootsData {
  /** 可用的起始目录绝对路径集合。 */
  roots: string[]
}

/** 新建目录请求体。 */
export interface ICreateDirectoryRequest {
  /** 父目录绝对路径。 */
  parentPath: string
  /** 新建目录名称（单层名称，不包含路径分隔符）。 */
  name: string
}

/** 新建目录结果。 */
export interface ICreateDirectoryData {
  /** 新建成功的目录绝对路径。 */
  absolutePath: string
}

export type IListDirectoryResponse = IApiSuccessResponse<IDirectoryListing>
export type IBrowseRootsResponse = IApiSuccessResponse<IBrowseRootsData>
export type ICreateDirectoryResponse = IApiSuccessResponse<ICreateDirectoryData>
