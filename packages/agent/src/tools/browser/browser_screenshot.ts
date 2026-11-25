/**
 * browser_screenshot 工具：截取页面或指定元素的截图并交给模型。
 *
 * 供「页面元素核对」阶段使用：可访问性树只有语义结构、无视觉布局，依赖页面正确的
 * ARIA 标注；Canvas/表格密集型界面（如打印设计器）的树结构意义有限，
 * 「元素被遮挡」「布局错乱」这类问题只能靠看图发现。
 *
 * 使用策略（与生成提示词一致）：优先用 browser_snapshot 取结构信息，
 * 仅当页面复杂、快照不清晰或需要确认视觉呈现时才截图——否则逐元素截图会撑爆上下文。
 *
 * 体积闸门放在本工具而非引擎：引擎契约只负责产出图片字节，不判断「多大算过大」；
 * 2MB 上限与降级为文字占位的姿态与 test-report-renderer 的附件处理保持一致。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  IAgentToolImageRef,
  IPageScreenshot,
} from '@charlie_deng/e2e-assistant-types'
import type { IBrowserSessionHost } from './Browser_session'

/**
 * 单张截图允许回传模型的最大原始字节数。
 *
 * 与 `test-report-renderer.ts` 的内嵌上限同值（2MB）。超过时降级为文字占位，
 * 避免超大图片进入模型上下文与工具审计链路。
 */
const DEFAULT_MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024

/** base64 字符数换算原始字节数的系数（base64 每 3 字节编码为 4 字符）。 */
const BASE64_TO_BYTES_RATIO = 3 / 4

/** browser_screenshot 工具接受的参数 Schema。 */
const screenshotParameters = Type.Object({
  /** 目标 iframe 的 frameId（由 browser_list_frames 返回）；缺省表示主文档。 */
  frameId: Type.Optional(
    Type.String({
      description:
        '目标 iframe 的 frameId（由 browser_list_frames 返回）。缺省或不传时操作主文档。',
    }),
  ),  /** 目标元素 selector；缺省截取整个可视区域。 */
  selector: Type.Optional(
    Type.String({
      description:
        '要截图元素的 CSS 或 Playwright selector，例如 [data-testid=preview]、.print-canvas。缺省截取整个可视区域。',
    }),
  ),
  /** 是否截取整页。 */
  fullPage: Type.Optional(
    Type.Boolean({
      description:
        '是否截取整页（含需要滚动才能看到的区域）。仅在未指定 selector 时生效，缺省只截当前可视区域。',
    }),
  ),
})

/** browser_screenshot 工具返回的结构化执行详情。 */
export interface BrowserScreenshotDetails {
  /** 本次截图使用的 selector；截取整页或可视区域时为 undefined。 */
  selector?: string
  /** 图片宽度（像素）。 */
  width: number
  /** 图片高度（像素）。 */
  height: number
  /** 图片 MIME 类型。 */
  mimeType: string
  /** 是否因超出体积上限而未回传图片本体。 */
  skipped: boolean
  /**
   * 图片引用（v12-pre）：宿主归档成功后返回，供客户端在工具卡片上展示缩略图。
   *
   * 与回传模型的 `content` 图片各走一条路：模型侧走 vision 通道拿 base64，
   * 界面侧走本引用按 URL 拉取。归档未注入或失败时省略该字段，
   * 此时界面不展示缩略图，但工具本身仍然成功。
   */
  image?: IAgentToolImageRef
}

/**
 * 把 base64 长度换算为原始字节数。
 *
 * @param base64Length - base64 编码后的字符数。
 * @returns 对应的原始字节数（向上取整）。
 * @throws 不抛出异常。
 */
function toRawByteSize (base64Length: number): number {
  return Math.ceil(base64Length * BASE64_TO_BYTES_RATIO)
}

/**
 * 归档截图供界面展示。
 *
 * 归档是**旁路能力**：未注入端口（如普通 Chat）或归档失败时，截图依然成功返回给模型，
 * 只是界面不展示缩略图。因此这里吞掉异常并返回 undefined，不把界面展示问题
 * 升级为工具失败——否则一次磁盘写入故障会让 Agent 的页面核对整体中断。
 *
 * @param host - 浏览器会话宿主（可能未注入归档端口）。
 * @param screenshot - 引擎返回的截图。
 * @param selector - 本次截图的目标 selector，用于生成可读文件名。
 * @returns 图片引用；未注入端口或归档失败时返回 undefined。
 * @throws 不抛出异常。
 */
async function archiveScreenshot (
  host: IBrowserSessionHost,
  screenshot: IPageScreenshot,
  selector: string | undefined,
): Promise<IAgentToolImageRef | undefined> {
  const archive = host.screenshotArchive
  if (!archive) return undefined

  try {
    return await archive.archive(screenshot, {
      ...(selector !== undefined ? { selector } : {}),
      capturedAt: Date.now(),
    })
  } catch {
    // 归档失败不影响截图结果本身：界面少一张图，模型仍能看到。
    return undefined
  }
}

/**
 * 创建截取页面截图的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主。
 * @returns 可直接配置到 AgentTool[] 的 browser_screenshot 工具。
 * @throws 不在创建阶段抛出异常；selector 非法、元素不存在、取消或浏览器断连时
 * 由宿主抛出结构化错误，并由运行器记为工具失败。
 */
export function createBrowserScreenshotTool (
  host: IBrowserSessionHost,
): AgentTool<typeof screenshotParameters, BrowserScreenshotDetails> {
  return {
    name: 'browser_screenshot',
    label: '页面截图',
    description:
      '截取页面或指定元素的截图并返回图片，用于确认视觉呈现（元素是否被遮挡、布局是否错乱、Canvas 内容是否正确）。优先使用 browser_snapshot 获取结构信息，仅在快照不清晰或需要确认视觉效果时才截图。',
    parameters: screenshotParameters,
    executionMode: 'sequential',
    /**
     * 截取页面截图并作为图片内容返回。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的目标 selector 与整页开关。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；单次截图无中间进度。
     * @returns 图片内容 + 尺寸说明文本；超限时仅返回文字占位。
     * @throws 由宿主抛出的结构化浏览器错误透传，由运行器记为工具失败。
     */
    async execute (toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      const screenshot = await host.captureScreenshot({
        ...(parameters.selector !== undefined
          ? { selector: parameters.selector }
          : {}),
        ...(parameters.fullPage !== undefined
          ? { fullPage: parameters.fullPage }
          : {}),
      })

      const target = parameters.selector
        ? `元素「${parameters.selector}」`
        : parameters.fullPage === true
          ? '整页'
          : '当前可视区域'
      const sizeText = `${screenshot.width}×${screenshot.height}`
      const rawBytes = toRawByteSize(screenshot.data.length)

      // 超限时降级为文字占位：图片已成功截取，只是不回传本体，需说明原因而非报错。
      if (rawBytes > DEFAULT_MAX_SCREENSHOT_BYTES) {
        return {
          content: [
            {
              type: 'text',
              text: `已截取${target}，但图片体积 ${(rawBytes / 1024 / 1024).toFixed(1)}MB 超过 ${DEFAULT_MAX_SCREENSHOT_BYTES / 1024 / 1024}MB 上限，未回传图片内容（尺寸 ${sizeText}）。请改用 browser_query 核对具体元素，或缩小截图范围（指定更小的 selector）。`,
            },
          ],
          details: {
            ...(parameters.selector !== undefined
              ? { selector: parameters.selector }
              : {}),
            width: screenshot.width,
            height: screenshot.height,
            mimeType: screenshot.mimeType,
            skipped: true,
          },
        }
      }

      const archivedImage = await archiveScreenshot(
        host,
        screenshot,
        parameters.selector,
      )

      return {
        content: [
          {
            type: 'image',
            data: screenshot.data,
            mimeType: screenshot.mimeType,
          },
          {
            type: 'text',
            text: `已截取${target}（尺寸 ${sizeText}，${screenshot.mimeType}）。请依据这张图确认页面的视觉呈现。`,
          },
        ],
        details: {
          ...(parameters.selector !== undefined
            ? { selector: parameters.selector }
            : {}),
          width: screenshot.width,
          height: screenshot.height,
          mimeType: screenshot.mimeType,
          skipped: false,
          ...(archivedImage ? { image: archivedImage } : {}),
        },
      }
    },
  }
}
