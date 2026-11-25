import type { IApiSuccessResponse } from './common'

export interface ISkillSummary {
  id: string
  title: string
  description: string
  version: string
  createdAt: string
  updatedAt: string
}

export interface ISkillDetail extends ISkillSummary {
  readOnly: boolean
}

export interface ISkillDirectoryTreeNode {
  kind: 'directory'
  name: string
  relativePath: string
  children: ISkillFileTreeNode[]
  /**
   * 受保护根目录标记（v14）：该节点不可删除、不可重命名。
   *
   * 当前仅 `userWorkSpace` 根目录使用；前端据此隐藏删除按钮并渲染锁定图标，
   * 服务端删除入口是最终防线（两层判定共用同一保护清单）。
   * 文件节点上出现同名标记的含义见 {@link ISkillFileTreeFileNode.protection}。
   */
  protection?: 'user-workspace-root'
  /**
   * 降级提示（v14）：userWorkSpace 补建失败或不可写等原因，
   * 前端据此在文件树占位节点上展示说明（W20 空状态占位提示）。
   */
  notice?: string
}

export interface ISkillFileTreeFileNode {
  kind: 'file'
  name: string
  relativePath: string
  size: number
  openability: 'known_text' | 'known_unsupported' | 'unchecked'
  readOnly: boolean
  disabledReason?: 'too_large' | 'unsupported' | 'hard_link'
  /**
   * 受保护根标记（v14）：与目录节点对称，语义不依赖 kind。
   *
   * 仅出现在 `userWorkSpace` 路径被同名**普通文件**占用的边缘场景（W10）——
   * 此时扫描产出的是文件节点，但仍需标记为受保护根，前端据此隐藏删除按钮、
   * 渲染锁定图标（W21）。服务端删除入口是最终防线。
   */
  protection?: 'user-workspace-root'
  /**
   * 降级提示（v14）：补建失败原因（如被同名文件占用），
   * 前端在锁定图标的 Tooltip 上展示（W20 占位提示）。
   */
  notice?: string
}

export type ISkillFileTreeNode =
  ISkillDirectoryTreeNode | ISkillFileTreeFileNode

export interface ISkillFileContent {
  relativePath: string
  content: string
  language: string
  readOnly: boolean
  version: string
  size: number
  updatedAt: string
  lineEnding: 'lf' | 'crlf'
  hasUtf8Bom: boolean
}

export type IListSkillsResponse = IApiSuccessResponse<ISkillSummary[]>
export type IGetSkillResponse = IApiSuccessResponse<ISkillDetail>
export type IListSkillFilesResponse = IApiSuccessResponse<ISkillFileTreeNode[]>
export type IGetSkillFileResponse = IApiSuccessResponse<ISkillFileContent>

/**
 * Skill 内图片文件的字节内容（v13 图片预览）。
 *
 * 与 `ISkillFileContent` 的分工：后者是**文本编辑器**的内容模型（含 content 文本、
 * 行尾、BOM 等编辑元数据），二进制图片无法套用；本类型只描述「字节 + 类型」，
 * 由字节路由直接写入 HTTP 响应体，不作为 JSON 返回。
 */
export interface ISkillFileImageContent {
  /** 图片在 Skill 内的相对路径（POSIX 分隔符，已归一化）。 */
  relativePath: string
  /** 图片原始字节。 */
  bytes: Uint8Array
  /** 图片 MIME 类型，取值来自 `PREVIEWABLE_IMAGE_MIME_TYPES`。 */
  mimeType: string
  /** 图片体积（字节）。 */
  size: number
}

/**
 * 可预览图片的扩展名 → MIME 类型映射。
 *
 * 前后端共用同一份清单，避免两侧各写一遍而漂移：服务端据此判定
 * 「该二进制文件能否以图片预览方式提供」并选择 `Content-Type`，
 * 前端据此判定「文件树节点是否可点开图片预览」。
 *
 * 取舍说明：
 *   - 只收浏览器可直接渲染的**位图**格式。`.svg` 不收——它是可执行脚本载体
 *     （内可含 `<script>`），作为图片直接内联渲染会引入 XSS 面；`.pdf`、`.ico`、
 *     `.tiff` 等浏览器支持不一致或不适合作为「图片」呈现，一并不收。
 *   - 键均为小写且含前导点，与 `path.extname()` 的返回值口径一致。
 */
export const PREVIEWABLE_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * 判断扩展名是否为可直接预览的图片。
 *
 * @param extension 文件扩展名，大小写不敏感，需含前导点（如 `.png`）。
 * @returns 可预览时返回对应 MIME 类型，否则返回 undefined。
 * @throws 不抛出异常。
 */
export function resolvePreviewImageMimeType(
  extension: string,
): string | undefined {
  return PREVIEWABLE_IMAGE_MIME_TYPES[extension.toLowerCase()]
}

export interface ICreateSkillRequest {
  title: string
  description?: string
}

export type ICreateSkillResponse = IApiSuccessResponse<ISkillSummary>

export type IDeleteSkillResponse = IApiSuccessResponse<{
  skillId: string
}>

export interface IUpdateSkillFileRequest {
  relativePath: string
  content: string
  expectedVersion: string
}

/**
 * Skill 创建时生成、因而**不允许删除**的根目录文件名（v13）。
 *
 * 前后端共用同一份清单，避免两侧各写一遍而漂移：服务端据此在删除前拦截，
 * 前端据此隐藏删除按钮（即时反馈）。服务端是最终防线——前端隐藏只是体验优化。
 *
 * 为什么保护这三个：
 *   - `manifest.json` 决定 Skill 的 ID 与目录名，缺失即无法寻址；
 *   - `e2e_schema.json` 是结构化用例的唯一数据源；
 *   - `env.json` 保存敏感数据真实值，删除会让 `${ENV:KEY}` 引用全部失效。
 *
 * 仅约束**根目录下**的同名文件：子目录中的同名文件是用户自建内容，允许删除。
 */
export const PROTECTED_SKILL_ROOT_FILE_NAMES: readonly string[] = [
  'manifest.json',
  'e2e_schema.json',
  'env.json',
]

/**
 * 判断相对路径是否命中受保护的创建期文件。
 *
 * @param relativePath Skill 内相对路径（POSIX 分隔符）。
 * @returns 命中保护清单时返回 true；目录中的同名文件返回 false。
 * @throws 不抛出异常。
 */
export function isProtectedSkillRootFile(relativePath: string): boolean {
  if (relativePath.includes('/')) return false
  return PROTECTED_SKILL_ROOT_FILE_NAMES.includes(relativePath.toLowerCase())
}

/**
 * Skill 根目录下受保护的目录名（v14，PRD W12/W13）。
 *
 * 这些目录不可删除、不可重命名、不可移动。清单保留目录的规范大小写以便阅读，
 * 但**判定一律大小写不敏感**（见 {@link isProtectedSkillRootEntry}）——
 * Windows 文件系统大小写不敏感，'UserWorkSpace' 等变体指向同一目录，必须同样拦截。
 */
export const PROTECTED_SKILL_ROOT_DIRECTORY_NAMES: readonly string[] = [
  'userWorkSpace',
]

/**
 * 判断相对路径是否命中受保护的创建期文件或受保护根目录（v14 扩展）。
 *
 * 与 {@link isProtectedSkillRootFile} 的差异：后者语义仍是「创建期文件」，
 * 本函数额外覆盖受保护根目录（当前仅 `userWorkSpace`）。删除入口（服务端
 * file-delete 与前端按钮判定）应使用本函数，保证两层判定共用同一清单。
 *
 * 目录名比较对**清单项与入参两侧**都归一为小写：清单以规范大小写书写，
 * 只把入参小写化会永不命中（W13 的大小写变体拦截依赖这一点）。
 *
 * @param relativePath Skill 内相对路径（POSIX 分隔符）。
 * @returns 命中保护清单时返回 true；子目录中的同名条目返回 false。
 * @throws 不抛出异常。
 */
export function isProtectedSkillRootEntry(relativePath: string): boolean {
  if (relativePath.includes('/')) return false
  const lowerCasedPath = relativePath.toLowerCase()
  return (
    isProtectedSkillRootFile(relativePath) ||
    PROTECTED_SKILL_ROOT_DIRECTORY_NAMES.some(
      (name) => name.toLowerCase() === lowerCasedPath,
    )
  )
}

/**
 * 删除 Skill 内文件或目录的响应（v13）。
 *
 * 目录会被递归删除，因此不返回被删内容清单——调用方刷新文件树即可看到结果。
 */
export type IDeleteSkillFileResponse = IApiSuccessResponse<{
  /** 被删除内容在 Skill 内的相对路径。 */
  relativePath: string
  /** 被删除内容的类型，供前端组织提示文案。 */
  kind: 'file' | 'directory'
}>

export type IUpdateSkillFileResponse = IApiSuccessResponse<{
  relativePath: string
  version: string
  size: number
  updatedAt: string
}>

/**
 * 在 userWorkSpace 内新建子目录的请求（v14 D1/W14）。
 *
 * `path` 是 userWorkSpace 内相对路径（不含 `userWorkSpace` 前缀，服务端拼接根），
 * 因此不存在「前端指定根」的攻击面——用户不能在 userWorkSpace 外创建（B4）。
 */
export interface ICreateSkillDirectoryRequest {
  /** userWorkSpace 内相对路径，支持多级（如 `exports/2026`）。 */
  path: string
}

/**
 * 在 userWorkSpace 内新建文本文件的请求（v14 D1/W14）。
 *
 * 创建语义（不覆盖已有文件）；与既有 `PUT /file`（更新 + 版本冲突检测）分工。
 */
export interface ICreateSkillFileRequest {
  /** userWorkSpace 内相对路径（父目录不存在时自动创建）。 */
  path: string
  /** 文件初始内容（v14 R10：创建空文件，内容通常为空字符串）。 */
  content: string
}

/** 新建目录的响应：返回创建后的 Skill 内完整相对路径。 */
export type ICreateSkillDirectoryResponse = IApiSuccessResponse<{
  relativePath: string
}>

/** 新建文件的响应：返回完整相对路径、内容版本与字节数。 */
export type ICreateSkillFileResponse = IApiSuccessResponse<{
  relativePath: string
  version: string
  size: number
}>
