/**
 * browser_capture_baseline 工具：把元素截图保存为「新旧 DOM 截图对比」的基线
 * （v12 引入，v14 落盘根迁入 userWorkSpace）。
 *
 * 用途（PRD 条目②）：用户要求在流程步骤中做页面的新旧 DOM 对比时，基线必须先存在。
 * 本工具一次完成两件事：**看当前页面**（回传图片给模型）与**存下基线**
 * （落盘到 `<skill>/userWorkSpace/<分组>/<文件名>`，供执行期 `toMatchSnapshot` 比对；
 * 默认分组为 `baselines`，即 `userWorkSpace/baselines/`，B1）。
 *
 * 与 browser_screenshot 的分工：
 *   - `browser_screenshot` 是**只读**的视觉确认，截图只回传模型、不落盘（归档失败可降级）；
 *   - 本工具产出的基线是**正式产物**，落盘失败必须明确报错，不静默降级——
 *     否则执行期会因为「基线不存在」而全部失败，且用户看不出根因。
 *
 * 调用时机约束（B9/B12/A15）：仅当用户通过提问回答、卡片提交或对话原话**明确表达
 * 同意捕获/创建基准**（提交指向不存在路径的回答即视为同意，B9/Q5），或明确要求更新
 * （重新捕获）基线时才调用本工具；不得凭默认目录或猜测自动捕获，除此之外不得自动
 * 覆盖同名基线（B12）。
 *
 * 注意：本约束是**语义约束**，不再有平台侧的结构化信号（如 action='capture'）兜底——
 * 「是否已获同意」由模型按 `playwright_script_generation` Skill 的视觉回归规则自行判读。
 *
 * 截图采用「完整内容」口径（含元素内部滚动区域），与生成脚本内联模板同源，
 * 保证基线捕获与实际比对是同一手法（v12 技术方案 §5.3）。
 */

import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { IBrowserSessionHost } from './Browser_session'

/**
 * 单张基线允许回传模型的最大原始字节数。
 *
 * 与 `browser_screenshot`、`test-report-renderer` 同值（2MB）：超限时**不再回传图片本体**，
 * 但**基线仍然落盘成功**——落盘上限（skill-manager）与回传上限是两件事，
 * 前者决定产物能否留存，后者只影响模型能否看到。
 */
const DEFAULT_MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024

/** base64 字符数换算原始字节数的系数（base64 每 3 字节编码为 4 字符）。 */
const BASE64_TO_BYTES_RATIO = 3 / 4

/**
 * browser_capture_baseline 工具接受的参数 Schema。
 */
const captureBaselineParameters = Type.Object({
  /** 目标元素的 CSS 或 Playwright selector。 */
  selector: Type.String({
    description:
      '要作为基线截图元素的 CSS 或 Playwright selector，例如 [data-testid=preview]、.print-canvas。元素存在内部滚动时截图会包含完整滚动内容。',
  }),
  /** 基线分组目录分段。 */
  segments: Type.Array(Type.String(), {
    description:
      "userWorkSpace 内相对目录分段，例如 ['baselines']（默认基准目录）或 ['preview']。必须与脚本内 toMatchSnapshot(['<分段>', '<文件名>']) 的分段完全一致。",
    minItems: 1,
  }),
  /** 基线文件名。 */
  fileName: Type.String({
    description:
      '基线文件名，必须以 .png 结尾，例如 candidate-a.png。同一分组内允许多个候选（执行期任一命中即通过）。',
  }),
})

/** browser_capture_baseline 工具返回的结构化执行详情。 */
export interface BrowserCaptureBaselineDetails {
  /** 截图使用的 selector。 */
  selector: string
  /** 分组目录分段。 */
  segments: string[]
  /** 基线文件名。 */
  fileName: string
  /** 基线在 Skill 内的相对路径（POSIX 分隔符）。 */
  relativePath: string
  /** 图片宽度（像素）。 */
  width: number
  /** 图片高度（像素）。 */
  height: number
  /** 是否因超出回传上限而未把图片交给模型（基线仍已落盘）。 */
  imageOmitted: boolean
}

/**
 * 把 base64 长度换算为原始字节数。
 *
 * @param base64Length - base64 编码后的字符数。
 * @returns 对应的原始字节数（向上取整）。
 * @throws 不抛出异常。
 */
function toRawByteSize(base64Length: number): number {
  return Math.ceil(base64Length * BASE64_TO_BYTES_RATIO)
}

/**
 * 创建「捕获视觉基线」的 Agent 工具。
 *
 * @param host - 本次生成任务绑定的浏览器会话宿主；未注入基线归档端口时工具明确失败。
 * @returns 可直接配置到 AgentTool[] 的 browser_capture_baseline 工具。
 * @throws 不在创建阶段抛出异常；selector 非法、元素不存在、未注入归档端口、
 * 取消或浏览器断连时由宿主抛出结构化错误，并由运行器记为工具失败。
 */
export function createBrowserCaptureBaselineTool(
  host: IBrowserSessionHost,
): AgentTool<typeof captureBaselineParameters, BrowserCaptureBaselineDetails> {
  return {
    name: 'browser_capture_baseline',
    label: '捕获视觉基线',
    description:
      '把页面上某元素的截图保存为「新旧 DOM 对比」的基线图片（含元素内部滚动区域的完整内容），并同时把图片返回给你确认。调用前提：用例步骤要求做截图对比，且基线尚不存在时**必须已得到用户的明确同意**（用户经提问回答确认捕获，或明确要求更新/重新捕获基线）；不得凭默认目录或自行猜测就捕获，也不得自动覆盖同名基线。落盘失败会明确报错，不会静默跳过。',
    parameters: captureBaselineParameters,
    // 截图与落盘都作用于共享页面和 Skill 目录，必须串行执行。
    executionMode: 'sequential',
    /**
     * 捕获完整内容截图并归档为基线。
     *
     * @param toolCallId - 当前工具调用标识；本工具不使用该标识。
     * @param parameters - 已校验的 selector、分组分段与文件名。
     * @param signal - 取消信号；实际取消由宿主持有的会话信号统一处理。
     * @param onUpdate - 流式进度回调；单次捕获无中间进度。
     * @returns 基线路径 + 图片内容；超出回传上限时仅返回文字说明（基线仍已落盘）。
     * @throws 未注入归档端口、selector 非法、元素不存在时抛出，由运行器记为工具失败。
     */
    async execute(toolCallId, parameters, signal, onUpdate) {
      void toolCallId
      void signal
      void onUpdate

      // 基线是正式产物：未注入归档端口时明确失败，不静默降级为「只回传不落盘」，
      // 否则执行期会因基线缺失而整体失败，且用户看不到根因。
      const archive = host.visualBaselineArchive
      if (!archive) {
        throw new Error(
          '当前会话未启用视觉基线归档，无法保存基线。请确认在 Skill 开发页内、并对当前 Skill 执行生成任务。',
        )
      }

      const screenshot = await host.captureFullContentScreenshot({
        selector: parameters.selector,
      })

      // 先落盘再决定是否回传图片：落盘是产物的必要条件，回传只是模型体验。
      const archived = await archive.archive(screenshot, {
        segments: parameters.segments,
        fileName: parameters.fileName,
      })

      const rawBytes = toRawByteSize(screenshot.data.length)
      const sizeText = `${archived.width}×${archived.height}`
      const locationText = `${parameters.segments.join('/')}/${parameters.fileName}`

      // 超限时仍报告落盘成功，只是不把图片交给模型（避免撑爆上下文）。
      if (rawBytes > DEFAULT_MAX_SCREENSHOT_BYTES) {
        return {
          content: [
            {
              type: 'text',
              text: `基线已保存到 ${archived.relativePath}（元素「${parameters.selector}」，尺寸 ${sizeText}）。图片体积 ${(rawBytes / 1024 / 1024).toFixed(1)}MB 超过 ${DEFAULT_MAX_SCREENSHOT_BYTES / 1024 / 1024}MB 回传上限，未回传图片内容（基线本身已正常保存）。请在脚本中用 toMatchSnapshot(['${parameters.segments.join("', '")}', '${parameters.fileName}']) 引用该基线。`,
            },
          ],
          details: {
            selector: parameters.selector,
            segments: [...parameters.segments],
            fileName: parameters.fileName,
            relativePath: archived.relativePath,
            width: archived.width,
            height: archived.height,
            imageOmitted: true,
          },
        }
      }

      return {
        content: [
          {
            type: 'image',
            data: screenshot.data,
            mimeType: screenshot.mimeType,
          },
          {
            type: 'text',
            text: `基线已保存到 ${archived.relativePath}（元素「${parameters.selector}」，尺寸 ${sizeText}）。请确认这张图确实是期望的基准画面；在脚本中用 toMatchSnapshot(['${parameters.segments.join("', '")}', '${parameters.fileName}']) 引用它。若同一分组需要多个候选基线，请用不同文件名重复调用。`,
          },
        ],
        details: {
          selector: parameters.selector,
          segments: [...parameters.segments],
          fileName: parameters.fileName,
          relativePath: archived.relativePath,
          width: archived.width,
          height: archived.height,
          imageOmitted: false,
        },
      }
    },
  }
}

/** 导出供测试断言使用（与工具内的判定保持同源）。 */
export const captureBaselineLimits = {
  maxScreenshotBytes: DEFAULT_MAX_SCREENSHOT_BYTES,
} as const
