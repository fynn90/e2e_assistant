/**
 * Skill 内图片文件的字节读取（v13）：供「图片预览」字节路由使用。
 *
 * 为什么需要独立模块：`file-content.ts` 的 `readSkillFile` 是**文本编辑器**的读取路径，
 * 它会在扩展名白名单（`KNOWN_BINARY_EXTENSIONS`）、NUL 字节、UTF-8 解码三处拒绝二进制；
 * 图片要展示就必须绕开文本语义，改按「原始字节 + MIME」提供。
 *
 * 与既有两个字节服务的关系：
 *   - `exploration-artifact.ts`（探查截图）与 `visual-baseline.ts`（视觉基线）都服务于
 *     **固定目录 + 白名单文件名**，路径形态受限；
 *   - 本模块服务于**任意 Skill 内相对路径**，因此安全边界完全依赖
 *     `resolveSafeSkillFilePath` 的逐段符号链接检测与归一化前缀校验，
 *     再叠加「扩展名必须是可预览图片」这一层收敛，把可读取面收窄到图片。
 *
 * 不做内容嗅探（magic number 校验）：扩展名与 MIME 已由共享清单
 * （`PREVIEWABLE_IMAGE_MIME_TYPES`）统一，且客户端的 `<img>` 解码失败会自行降级；
 * 额外解码会引入图像依赖，收益不抵复杂度。
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  resolvePreviewImageMimeType,
  type ISkillFileImageContent,
} from '@fynn90-e2e_assistant/types'
import { MAX_SKILL_FILE_BYTES } from './constants'
import { resolveSkill } from './detail'
import { SkillManagerError } from './errors'
import { resolveSafeSkillFilePath } from './path-guard'
import type { ISkillStorageOptions } from './storage'

/**
 * 图片文件的体积上限（原始字节）。
 *
 * 3 MiB：比文本文件上限（1 MiB）宽，因为位图天然更大；但仍设上界，
 * 避免超大图片一次性读入内存并经 HTTP 传输。与探查截图/基线的 2 MiB
 * 上限口径接近，差异来自此处允许 jpg/webp 等压缩率不同的格式。
 */
export const MAX_PREVIEW_IMAGE_BYTES = 3 * 1024 * 1024

/**
 * 读取 Skill 内一张可预览图片的原始字节。
 *
 * @param options - Skill 存储根目录（`rootDir`）。
 * @param skillId - 九位 Skill ID。
 * @param relativePath - 图片在 Skill 内的相对路径（POSIX 分隔符）。
 * @returns 图片字节、MIME 类型与归一化后的相对路径。
 * @throws {SkillManagerError} 路径非法（INVALID_FILE_PATH）、不是可预览图片
 *   （FILE_NOT_SUPPORTED）、超出体积上限（FILE_TOO_LARGE）、
 *   文件不存在（FILE_NOT_FOUND）或读取失败（SKILL_CORRUPTED）时抛出。
 */
export async function readSkillImageFile (
  options: ISkillStorageOptions,
  skillId: string,
  relativePath: string,
): Promise<ISkillFileImageContent> {
  const resolvedSkill = await resolveSkill(options, skillId)
  const resolvedPath = await resolveSafeSkillFilePath(
    resolvedSkill.skillRoot,
    relativePath,
  )

  // 收敛读取面：只放行可预览的图片格式。非图片一律按「不支持」处理，
  // 让尝试读取 pdf/zip 等二进制的请求在这里终止，而不必等到读取之后。
  const mimeType = resolvePreviewImageMimeType(
    path.extname(resolvedPath.relativePath),
  )
  if (!mimeType) {
    throw new SkillManagerError(
      'FILE_NOT_SUPPORTED',
      '该文件类型不支持图片预览。',
    )
  }

  if (resolvedPath.stat.size > MAX_PREVIEW_IMAGE_BYTES) {
    throw new SkillManagerError('FILE_TOO_LARGE', '图片超过预览体积上限。')
  }

  let bytes: Buffer

  try {
    bytes = await readFile(resolvedPath.absolutePath)
  } catch (error) {
    throw new SkillManagerError('SKILL_CORRUPTED', '读取图片文件失败。', error)
  }

  // 二次校验实际读取长度：`stat` 与读取之间存在竞态窗口（文件可能被替换或增长），
  // 只信 stat 会让上限形同虚设。
  if (bytes.byteLength > MAX_PREVIEW_IMAGE_BYTES) {
    throw new SkillManagerError('FILE_TOO_LARGE', '图片超过预览体积上限。')
  }

  return {
    relativePath: resolvedPath.relativePath,
    bytes,
    mimeType,
    size: bytes.byteLength,
  }
}
