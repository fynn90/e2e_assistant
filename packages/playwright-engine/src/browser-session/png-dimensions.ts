/**
 * 从 PNG 字节流头部读取图片尺寸的纯函数工具。
 *
 * Playwright 的截图接口只返回原始字节，不带尺寸信息；而 IPageScreenshot 契约
 * 需要 width/height 供调用方描述图片。PNG 的 IHDR 块固定位于文件最前端，
 * 因此读取 24 字节头部即可得到尺寸，不需要引入图像解码依赖。
 */

/** PNG 文件签名（8 字节）：固定魔数，用于确认输入确实是 PNG。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

/** IHDR 块的类型标识：PNG 规范要求它必须是第一个块。 */
const IHDR_CHUNK_TYPE = 'IHDR'

/** 读取 IHDR 尺寸所需的最小字节数：8 签名 + 4 长度 + 4 类型 + 4 宽 + 4 高。 */
const MIN_HEADER_BYTES = 24

/** 截图统一使用的图片类型（Playwright 截图恒为 PNG）。 */
export const PNG_MIME_TYPE = 'image/png'

/**
 * 图片尺寸。
 */
export interface IImageDimensions {
  width: number
  height: number
}

/**
 * 从 PNG 字节流头部读取图片宽高。
 *
 * @param buffer - PNG 文件字节内容。
 * @returns 图片宽高；输入不是合法 PNG 时返回 undefined。
 * @throws 不抛出异常；结构异常一律折算为 undefined。
 */
export function readPngDimensions(
  buffer: Buffer,
): IImageDimensions | undefined {
  if (buffer.length < MIN_HEADER_BYTES) {
    return undefined
  }

  const hasValidSignature = PNG_SIGNATURE.every(
    (byte, index) => buffer[index] === byte,
  )
  if (!hasValidSignature) {
    return undefined
  }

  // 块类型是 4 个 ASCII 字符，位于签名之后的长度字段（4 字节）之后。
  if (buffer.toString('latin1', 12, 16) !== IHDR_CHUNK_TYPE) {
    return undefined
  }

  // 宽高为 IHDR 块开头的两个大端 uint32。
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)

  // 0 尺寸不是合法图片，按解析失败处理，避免把无意义尺寸传给调用方。
  if (width === 0 || height === 0) {
    return undefined
  }

  return { width, height }
}
