/**
 * Agent 工作过程的客户端渲染协议契约。
 *
 * 本模块定义 Agent 后端、CLI 网关与 Web 客户端之间共享的「工作可视化」事件类型。
 * 设计原则：一个事件 = 一个组件——客户端收到事件后不做语义猜测，
 * 直接按事件类型选择对应的展示组件渲染。
 *
 * 事件分为两类：
 *   1. 时间线块事件（thinking / content / tool / todo / command / interaction / notice / turn），
 *      遵循 begin → append → end 的生命周期，按 blockId 归并渲染；
 *   2. 旁路事件（file_change / status / heartbeat），不进时间线，
 *      驱动文件树、状态条等时间线之外的 UI 区域。
 *
 * 安全约束：凡涉及工具参数、结果、文件内容的字段，只允许携带经服务端
 * 安全投影（脱敏 + 截断）后的值，不可作为原始工具参数或审计证据回传。
 */

// ---------------------------------------------------------------------------
// 事件信封
// ---------------------------------------------------------------------------

/**
 * 客户端事件公共信封：所有工作事件共享的头部字段。
 */
export interface IAgentClientEventEnvelope {
  /** 会话 ID：事件归属的对话（任务）。 */
  sessionId: string
  /** 会话内单调递增序号：排序、去重、断线续传的依据（由服务端统一分配）。 */
  seq: number
  /** 工作块 ID：同一块的 begin/append/end 共享同一 blockId，客户端据此定位组件。 */
  blockId: string
  /** 事件发生时的毫秒时间戳。 */
  timestamp: number
}

// ---------------------------------------------------------------------------
// 4.1 思考块 thinking
// ---------------------------------------------------------------------------

/**
 * 思考块事件：Agent 的推理过程，客户端用折叠组件渲染。
 *
 * begin 创建折叠的「思考中…」组件；append 流式追加思考文本；
 * end 定型并展示耗时（「已思考 N 秒」）。
 */
export type TAgentThinkingEvent =
  | {
      /** 思考开始。 */
      type: 'thinking'
      phase: 'begin'
    }
  | {
      /** 思考内容增量。 */
      type: 'thinking'
      phase: 'append'
      /** 本次新增的思考文本（纯文本）。 */
      text: string
    }
  | {
      /** 思考结束。 */
      type: 'thinking'
      phase: 'end'
      /** 本次思考耗时（毫秒）。 */
      durationMs: number
    }

// ---------------------------------------------------------------------------
// 4.2 内容输出块 content
// ---------------------------------------------------------------------------

/**
 * 内容类型：决定客户端使用哪个渲染器。
 *
 * text     —— 纯文本，不解析；
 * markdown —— Markdown 文档渲染；
 * code     —— 代码高亮组件，language 指定语言；
 * uml      —— UML/图表渲染器（如 mermaid），内容为图源码；
 * html     —— HTML 片段，沙箱渲染（预留）。
 */
export type TAgentContentType = 'text' | 'markdown' | 'code' | 'uml' | 'html'

/**
 * 内容输出块事件：Agent 给用户的正式输出。
 *
 * begin 必须声明 contentType（及可选 language），客户端据此选择渲染器；
 * append 流式追加内容；end 定型。
 */
export type TAgentContentEvent =
  | {
      /** 内容输出开始。 */
      type: 'content'
      phase: 'begin'
      /** 内容类型：客户端渲染器选择依据。 */
      contentType: TAgentContentType
      /** contentType 为 code / uml 时的语言或图类型（如 'typescript'、'mermaid'）。 */
      language?: string
    }
  | {
      /** 内容增量。 */
      type: 'content'
      phase: 'append'
      /** 本次新增的内容文本。 */
      text: string
    }
  | {
      /** 内容输出结束。 */
      type: 'content'
      phase: 'end'
    }

// ---------------------------------------------------------------------------
// 4.3 工具调用块 tool
// ---------------------------------------------------------------------------

/**
 * 工具类别：客户端按类别选择**配色与样式**，无需认识具体工具名。
 *
 * browser —— 浏览器操作；file —— 文件读写；search —— 搜索/查找；
 * skill —— 加载/使用技能；data —— 数据查询/处理；other —— 其他。
 *
 * 本轴是**粗粒度分组**，只用于样式/配色，不用于选图标——同一大类下的不同动作
 * 需要不同图标（如「查询元素」与「点击元素」同属 browser），图标选择依据是 `action`。
 */
export type TAgentToolCategory =
  'browser' | 'file' | 'search' | 'skill' | 'data' | 'other'

/**
 * 工具动作：客户端按动作选择**图标**，无需认识具体工具名。
 *
 * 与 `TAgentToolCategory` 的关系：category 是分组（粗），action 是动作（细）。
 * 两者构成正交的两轴——「这个工具属于哪一类」与「它具体做了什么」。
 * 拆成两轴而非扩为一轴的原因：图标粒度需随工具增长而细化，而分组维度保持稳定；
 * 合成一个枚举会让它同时承担两种语义，新增一个动作就要动分组表。
 *
 * 每个动作对应一个独立图标（映射见 web 的 `modules/agent-work/icons.ts`），
 * 因此新增工具时必须在此登记动作，否则图标退化为 `other` 的扳手。
 */
export type TAgentToolAction =
  // —— 浏览器动作 ——
  | 'navigate'
  | 'snapshot'
  | 'query'
  | 'click'
  | 'select'
  | 'fill'
  | 'wait'
  | 'screenshot'
  | 'baseline'
  // —— 文件动作 ——
  | 'read'
  | 'write'
  | 'edit'
  // —— 检索动作 ——
  | 'grep'
  | 'find'
  // —— 其他 ——
  | 'skill'
  | 'test'
  | 'other'

/** 工具调用的最终状态。 */
export type TAgentToolStatus = 'succeeded' | 'failed'

/**
 * 工具调用块事件：一次工具调用的生命周期。
 *
 * begin 携带类别与人话描述；append 携带执行中的增量信息；end 携带最终状态与摘要。
 */
export type TAgentToolEvent =
  | {
      /** 工具调用开始。 */
      type: 'tool'
      phase: 'begin'
      tool: {
        /** 工具类别：客户端**样式/配色**选择依据（粗粒度分组）。 */
        category: TAgentToolCategory
        /** 工具动作：客户端**图标**选择依据（细粒度动作身份）。 */
        action: TAgentToolAction
        /** 一句话动作描述，直接展示，如「打开网页」「写入文件 SKILL.md」。 */
        title: string
        /** 补充信息，如 URL、文件路径、搜索关键词（已脱敏截断）。 */
        subtitle?: string
        /** 机器工具名（调试用，不直接展示）。 */
        toolName: string
        /** 安全投影后的参数预览（可选，展开可见）。 */
        argumentsPreview?: unknown
      }
    }
  | {
      /** 工具执行中的增量信息。 */
      type: 'tool'
      phase: 'append'
      /** 增量描述文本（如「已加载 3/5 个元素」），已脱敏截断。 */
      text: string
    }
  | {
      /** 工具调用结束。 */
      type: 'tool'
      phase: 'end'
      /** 最终状态。 */
      status: TAgentToolStatus
      /** 结果摘要，一句话，如「截图成功」「找到 12 处匹配」。 */
      summary?: string
      /** 执行耗时（毫秒）。 */
      durationMs: number
      /**
       * 结果附带的图片（v12-pre 页面截图）。
       *
       * 只携带**引用**而非图片字节：图片本体由 CLI 落盘到 Skill 的 temp/exploration/，
       * 客户端按 `url` 单独拉取。原因见 v12-pre 技术方案：把 base64 塞进 SSE
       * 帧会经过脱敏器（BINARY_KEY_PATTERN 会替换 data 字段）且拖累事件总线与
       * 断线续传缓冲，因此字节不走事件通道。
       *
       * 图片随 temp/ 在任务终态被删除，故该引用只在本次生成过程中有效。
       */
      image?: IAgentToolImageRef
    }

/**
 * 工具结果附带图片的引用信息（v12-pre）。
 *
 * 图片字节不随事件传输：服务端把截图落盘后只下发引用，
 * 客户端按 `url` 拉取。`width`/`height` 供前端预留占位高度，避免加载时布局跳动。
 *
 * 生命周期：图片位于 Skill 的 `temp/exploration/` 下，**任务终态随 temp/ 一并删除**，
 * 因此本引用只在生成过程中有效；历史会话中按 `url` 拉取会得到 404，客户端应展示占位。
 */
export interface IAgentToolImageRef {
  /** 图片拉取地址（同源相对路径）。 */
  url: string
  /** 图片 MIME 类型，当前恒为 image/png。 */
  mimeType: string
  /** 图片宽度（像素）。 */
  width: number
  /** 图片高度（像素）。 */
  height: number
}

// ---------------------------------------------------------------------------
// 4.3b 待办块 todo（v12-pre）
// ---------------------------------------------------------------------------

/** 待办项状态。 */
export type TAgentTodoStatus = 'pending' | 'in_progress' | 'completed'

/** 单个待办项。 */
export interface IAgentTodoItem {
  /** 待办项标识：Agent 在同一份清单内自行分配且保持稳定，用于原位更新。 */
  id: string
  /** 待办内容（一句话，已脱敏截断）。 */
  content: string
  /** 当前状态。 */
  status: TAgentTodoStatus
  /** 进行中的补充说明（可选，如「正在核对第 3 个元素」）。 */
  activeForm?: string
}

/**
 * 待办块事件（v12-pre）：Agent 为多步骤任务维护的核对清单。
 *
 * 只发 begin（全量快照）语义：每次更新携带完整清单，客户端整体替换渲染。
 * 不做 append 增量的原因：待办清单是「当前状态」而非「时间序列」，
 * 增量更新需要客户端重放状态机，反而容易与服务端不一致。
 *
 * 与状态条的关系：清单本身进时间线（用户可回看「当时计划做什么」），
 * 当前进度也驱动状态条（见 TAgentActivity 的 todo 语义）。
 */
export interface IAgentTodoEvent {
  type: 'todo'
  phase: 'begin'
  /** 完整待办清单（按执行顺序排列）。 */
  items: IAgentTodoItem[]
}

// ---------------------------------------------------------------------------
// 4.4 命令执行块 command
// ---------------------------------------------------------------------------

/**
 * 命令执行块事件：Agent 执行 shell/bash 命令，客户端用终端组件渲染。
 *
 * begin 携带完整命令；append 流式追加 stdout/stderr 输出；end 携带退出码。
 */
export type TAgentCommandEvent =
  | {
      /** 命令执行开始。 */
      type: 'command'
      phase: 'begin'
      /** 完整命令文本。 */
      command: string
      /** 执行目录（可选展示）。 */
      cwd?: string
    }
  | {
      /** 命令输出增量。 */
      type: 'command'
      phase: 'append'
      /** 输出来源。 */
      stream: 'stdout' | 'stderr'
      /** 输出增量文本。 */
      text: string
    }
  | {
      /** 命令执行结束。 */
      type: 'command'
      phase: 'end'
      /** 进程退出码；0 为成功。 */
      exitCode: number
      /** 执行耗时（毫秒）。 */
      durationMs: number
    }

// ---------------------------------------------------------------------------
// 4.5 前端交互块 interaction
// ---------------------------------------------------------------------------

/**
 * 交互方式：confirm —— 确认/取消；choice —— 多选一；input —— 自由输入。
 */
export type TAgentInteractionKind = 'confirm' | 'choice' | 'input'

/**
 * 交互来源（v14）：决定前端用哪张卡片渲染。
 *
 * 前端按它分发组件，不做内容嗅探——曾因靠标题猜主题（`title.includes('视觉基准')`）
 * 把展示层与领域耦合在一起。缺省视为 'ask-user-question'（平台当前唯一来源）。
 */
export type TAgentInteractionSource = 'ask-user-question'

/** 交互选项（kind 为 choice 时使用）。 */
export interface IAgentInteractionOption {
  /** 选项值：用户选择后回传给服务端。 */
  value: string
  /** 选项展示文案。 */
  label: string
  /** 选项补充说明（可选）。 */
  description?: string
  /**
   * 平台自动追加的固定「其它」选项标记（v14 D7）。
   *
   * host 附加在每个问题候选项末尾；选中后展开长文本输入（必填、上限 2000 字符，
   * 输入框下方有小确认按钮），确认后以文本作为该问题的回答（Q19/Q20）。
   */
  isOther?: boolean
}

/**
 * 多问题形态中的单个问题（v14 D5/D7）。
 *
 * 每个问题的候选项由 Agent 分析给出（2-5 项），平台在末尾追加固定「其它」选项；
 * 多问题形态渲染在 tabs 内，每题答完自动切到下一题，全部答完一次性提交（Q11）。
 * 每题都用统一的标准形态（候选单选 + 「其它」长文本），没有其它回答方式组合（Q12）。
 */
export interface IAgentInteractionQuestion {
  /** 问题 ID：回答以它为键回传，一张卡片内必须唯一。 */
  questionId: string
  /** 问题文案，同时用作 tab 标题，如「基准目录」。 */
  label: string
  /** 候选列表（host 组装时已在末尾追加「其它」）。 */
  options?: IAgentInteractionOption[]
  /** 「其它」长文本输入框的占位文案。 */
  placeholder?: string
}

/**
 * 交互的元信息（begin 事件携带）。
 */
export interface IAgentInteraction {
  /** 交互 ID：用户回答时回传，关联到服务端等待中的 Agent。 */
  interactionId: string
  /** 交互方式。 */
  kind: TAgentInteractionKind
  /**
   * 交互来源（v14）：前端据此分发渲染组件（`ask-user-question` → AskUserQuestion 卡片）。
   * 缺省视为 'ask-user-question'——平台当前只有这一个来源。
   */
  source?: TAgentInteractionSource
  /** 标题，如「即将执行删除操作」。 */
  title: string
  /** 详细说明（可选），如将被删除的文件列表。 */
  description?: string
  /** kind 为 choice 时的选项列表。 */
  options?: IAgentInteractionOption[]
  /** 超时时间（毫秒）；超时后按 timeoutValue 自动回答。 */
  timeoutMs?: number
  /** 超时自动回答值；未设置时超时视为拒绝/取消。 */
  timeoutValue?: string
  /**
   * 多问题形态（v14 D5）：提供时卡片渲染为 tabs（一问一 tab，答完自动切到下一题），
   * 全部答完一次性提交；缺省时为单问题形态。
   * 问题数上限 4（Q17）。自定义输入统一由「其它」选项承载（D7）。
   */
  questions?: IAgentInteractionQuestion[]
}

/**
 * 取消回答的哨兵值（v14）。
 *
 * AskUserQuestion 卡片**不提供取消出口**（提问的语义是「拿到答案才能继续」），
 * 该哨兵只在异常路径出现：会话中止或客户端断开时由宿主定格卡片，
 * 以及回答 API 被绕过前端直调时的兜底归一。Agent 收到它时不得使用部分答案。
 */
export const INTERACTION_CANCEL_ANSWER = '__cancelled__'

/**
 * 「其它」选项的固定值（v14 D7）。
 *
 * 由 host 追加在每个问题的候选项末尾，前端据此识别「其它」并展开长文本输入；
 * 提交时前端把该选项替换为用户输入的原文本，服务端不再见到这个值。
 */
export const INTERACTION_OTHER_OPTION_VALUE = '__other__'

/**
 * 「其它」长文本的长度上限（Q19/R11）。
 *
 * 前端即时校验并阻止提交；CLI 的回答 schema 用更宽的上限兜底直调。
 */
export const INTERACTION_OTHER_TEXT_LIMIT = 2000

/**
 * 交互回答（v14 D5）：
 * - 单问题形态：string（question.options 中某选项的 value，或「其它」的原文本）；
 * - 多问题形态：以 questionId 为键的回答表（每题的值为选项值或「其它」文本）。
 * 取消哨兵 {@link INTERACTION_CANCEL_ANSWER} 是 string，两种形态通用。
 */
export type TAgentInteractionAnswer = string | Record<string, string>

/**
 * 前端交互块事件：Agent 运行中向用户发问（双向事件的下行半边）。
 *
 * begin 创建可交互卡片；end 定格卡片展示回答结果。
 * 用户的回答通过独立 API 上行，不在事件流内。
 */
export type TAgentInteractionEvent =
  | {
      /** 交互发起：等待用户回答。 */
      type: 'interaction'
      phase: 'begin'
      interaction: IAgentInteraction
    }
  | {
      /** 交互结束：已有回答。 */
      type: 'interaction'
      phase: 'end'
      /** 对应 begin 的 interactionId。 */
      interactionId: string
      /**
       * 回答值（v14 D5 放宽类型）：
       * - 单问题形态：confirm 为 'yes'/'no'，choice 为 option.value，input 为文本；
       * - 多问题形态：以 questionId 为键的回答表；
       * - 取消：两种形态统一为哨兵值 INTERACTION_CANCEL_ANSWER。
       */
      answer: TAgentInteractionAnswer
      /** 回答来源：用户点击 / 超时自动 / 会话中止。 */
      answeredBy: 'user' | 'timeout' | 'aborted'
    }

// ---------------------------------------------------------------------------
// 4.6 文件变更 file_change（旁路事件）
// ---------------------------------------------------------------------------

/** 文件变更操作。 */
export type TAgentFileChangeOperation =
  'create' | 'update' | 'delete' | 'rename'

/**
 * 文件变更事件（旁路）：Agent 对工作区文件的新建 / 更新 / 删除 / 重命名。
 *
 * 不进时间线，专门驱动文件树实时刷新与编辑器版本同步。
 * 一次性事件，无 begin/append/end 生命周期；不落盘（文件树恢复以磁盘为准）。
 */
export interface IAgentFileChangeEvent {
  type: 'file_change'
  /** 变更操作。 */
  operation: TAgentFileChangeOperation
  /** 工作区内相对路径（与文件树节点路径一致）。 */
  path: string
  /** operation 为 rename 时的新路径。 */
  newPath?: string
  /** 变更后的文件版本：供编辑器乐观锁比对。 */
  version?: string
  /** 变更摘要，如「+120 -35 行」（可选）。 */
  summary?: string
  /** 触发该变更的工具调用 blockId：客户端可点击定位到时间线中的工具卡片（可选）。 */
  sourceBlockId?: string
}

// ---------------------------------------------------------------------------
// 4.7 提示块 notice
// ---------------------------------------------------------------------------

/**
 * 提示块事件：非致命警告与致命错误。
 *
 * warning 为黄色提示条（如「上下文过长已截断」）；
 * error 为红色提示条（如「模型调用失败」）。
 */
export interface IAgentNoticeEvent {
  type: 'notice'
  phase: 'begin'
  /** 提示级别。 */
  level: 'warning' | 'error'
  /** 用户可读描述。 */
  message: string
}

// ---------------------------------------------------------------------------
// 4.8 轮次分隔 turn
// ---------------------------------------------------------------------------

/** 一轮对话的结局。 */
export type TAgentTurnOutcome = 'succeeded' | 'failed' | 'aborted'

/** 一次模型调用的 Token 用量。 */
export interface IAgentTurnUsage {
  /** 输入 Token 数。 */
  inputTokens?: number
  /** 输出 Token 数。 */
  outputTokens?: number
}

/**
 * 轮次分隔事件：标识一轮对话的开始与结束，用于时间线分组与用量统计。
 */
export type TAgentTurnEvent =
  | {
      /** 新一轮开始。 */
      type: 'turn'
      phase: 'begin'
      /** 本轮运行 ID。 */
      runId: string
      /** 用户本轮输入的预览（截断至 200 字符）。 */
      inputPreview?: string
    }
  | {
      /** 本轮结束。 */
      type: 'turn'
      phase: 'end'
      /** 本轮运行 ID。 */
      runId: string
      /** 本轮结局。 */
      outcome: TAgentTurnOutcome
      /** 失败时的用户可读错误。 */
      errorMessage?: string
      /** 本轮 token 用量（可选）。 */
      usage?: IAgentTurnUsage
    }

// ---------------------------------------------------------------------------
// 4.9 旁路事件：status / heartbeat
// ---------------------------------------------------------------------------

/**
 * Agent 当前活动状态：驱动页面顶部状态条。
 *
 * idle —— 空闲；thinking —— 思考中；writing —— 输出内容；
 * tool_running —— 执行工具；command_running —— 执行命令；
 * waiting_user —— 等待用户回答交互。
 */
export type TAgentActivity =
  | 'idle'
  | 'thinking'
  | 'writing'
  | 'tool_running'
  | 'command_running'
  | 'waiting_user'

/**
 * 当前状态事件（旁路）：不进时间线，只驱动状态条。
 */
export interface IAgentStatusEvent {
  type: 'status'
  /** 当前活动状态。 */
  activity: TAgentActivity
  /** 状态条文案，如「打开网页 https://baidu.com」。 */
  label?: string
}

/**
 * 心跳事件（旁路）：无业务事件期间由服务端发出，保活连接。
 */
export interface IAgentHeartbeatEvent {
  type: 'heartbeat'
}

// ---------------------------------------------------------------------------
// 4.9b 工作台动作卡片 workbench_action（v16）
// ---------------------------------------------------------------------------

/**
 * 工作台动作：对话流中承载**用户可点击入口**的动作身份（PRD ID-6/ID-7/RUN-13）。
 *
 * 与工具块的区别：动作卡片由服务端/Agent 请求发布，点击后走独立动作接口
 * （不产生新的对话轮次），因此需要独立的事件类型与卡片组件。
 */
export type TAgentWorkbenchAction =
  /** 打开创建 SKILL 弹窗（PRD ID-6 / LOG-3：唯一允许离开对话流的动作）。 */
  | 'create-skill'
  /** 生成 SKILL.md（PRD ID-7 ①）。 */
  | 'generate-skill-document'
  /** 首次生成 Playwright 脚本（PRD ID-7 ②）。 */
  | 'generate-playwright-script'
  /** 重新生成脚本（GEN-10：需覆盖确认）。 */
  | 'update-playwright-script'
  /** 执行测试（PRD RUN-1）。 */
  | 'execute-test'
  /** 失败后重试（GEN-8）。 */
  | 'retry'
  /**
   * 修复脚本（v17，PRD G2）：基于失败报告 + 当前脚本 + 用例数据重新生成脚本。
   *
   * 与 update-playwright-script 的区别是**输入**而非动作形态：本动作携带
   * 失败上下文（reportRunId），服务端据此把失败摘要写进生成 prompt。
   * 实现上等同整体重生成，因此发起前必须告知（G2b），且与 GEN-10 的
   * 手工编辑覆盖确认合并为一次（不得连弹两次）。
   */
  | 'repair-script'

/** 动作卡片的生命周期状态：点击后定格为 consumed。 */
export type TAgentWorkbenchActionState = 'pending' | 'consumed' | 'expired'

/**
 * 工作台动作卡片事件（v16）。
 *
 * 只发 begin 语义：动作卡片是一次性入口，没有流式增量；
 * 状态变化（pending → consumed）以同一 blockId 重发本事件表达，
 * 客户端按 blockId 原位更新。
 */
export interface IAgentWorkbenchActionEvent {
  type: 'workbench_action'
  phase: 'begin'
  /** 动作 ID：点击接口的路径参数，也是本块的 blockId。 */
  actionId: string
  /** 动作身份。 */
  action: TAgentWorkbenchAction
  /** 目标 SKILL；create-skill 时为 null（此时尚无 SKILL）。 */
  skillId: string | null
  /** 目标 SKILL 标题（展示用）。 */
  skillTitle?: string
  /** 按钮文案。 */
  label: string
  /** 补充说明（如「脚本已被手工修改，重新生成将覆盖」）。 */
  description?: string
  /**
   * 点击前是否需要用户先确认（v16 GEN-10 的覆盖确认）。
   *
   * 独立成字段而不是靠 description 的文案判断：卡片的分派与行为必须由
   * 结构化字段决定，文案是给人看的、会随措辞调整（v14 立下的
   * 「按字段分派，不做内容嗅探」）。
   */
  requiresConfirm?: boolean
  /** 当前状态。 */
  state: TAgentWorkbenchActionState
}

// ---------------------------------------------------------------------------
// 4.9c 工作台任务卡片 workbench_task（v16）
// ---------------------------------------------------------------------------

/**
 * 任务种类：决定客户端用哪个组件渲染卡片主体。
 *
 * execution  —— 执行测试：内嵌执行区块（订阅执行总线）；
 * generation —— 生成产物：内嵌子会话时间线（订阅工作总线）。
 *
 * 两种任务合成一个块种类的原因：差异只在渲染分派，而状态镜像、
 * 终态持久化、互斥提示三者完全同构；拆成两块会让这些逻辑各写一遍。
 */
export type TAgentWorkbenchTaskKind = 'execution' | 'generation' | 'batch'

/** 任务卡片状态（PRD RUN-10 的结果语义与 GEN-8 的失败语义）。 */
export type TAgentWorkbenchTaskStatus =
  'running' | 'completed' | 'failed' | 'interrupted'

/**
 * 任务终态摘要（物化落盘，供历史回看，满足 PRD LOG-2）。
 *
 * 只放统计与引用，不放逐条日志：逐条日志仍在各自的流里（执行总线 / 子会话总线）。
 */
export interface IAgentWorkbenchTaskSummary {
  /** 执行：测试总数 / 通过 / 失败 / 中断 / 跳过。 */
  total?: number
  passed?: number
  failed?: number
  interrupted?: number
  skipped?: number
  /** 执行：总耗时（毫秒）。 */
  durationMs?: number
  /** 执行：运行时间戳（报告目录名，报告弹窗据此取数）。 */
  runId?: string
  /**
   * 执行：开始时间（ISO 字符串，PRD RPT-2 要求摘要展示「运行时间」）。
   *
   * 取执行服务的 `record.startedAt`——即真正开始跑的时刻，不是卡片发布时刻。
   */
  startedAt?: string
  /**
   * 执行：目标 URL（PRD RPT-2 要求摘要展示）。
   *
   * 取自用例数据的 `baseUrl`，经 `validateBaseUrl` 校验的**真实 URL**，
   * 不含 `${ENV:KEY}` 之类的引用，因此进摘要不违反 SEC-4（env 值不入卡片）。
   */
  baseUrl?: string
  /** 生成：产物诊断计数（v15 的「N 项提示」徽标数据源）。 */
  diagnostics?: number
}

/**
 * 工作台任务卡片事件（v16）。
 *
 * 生命周期：启动时发布一条 status='running'；终态时以**同一 blockId**
 * 重发一条携带 summary / errorMessage 的事件，客户端原位更新。
 */
export interface IAgentWorkbenchTaskEvent {
  type: 'workbench_task'
  phase: 'begin'
  /**
   * 任务 ID：执行任务为 executionId，生成任务为子会话 sessionId。
   * 客户端据此内嵌订阅对应的实时事件流。
   */
  taskId: string
  /** 任务种类：客户端渲染分派依据。 */
  taskKind: TAgentWorkbenchTaskKind
  /** 目标 SKILL。 */
  skillId: string
  /** 目标 SKILL 标题。 */
  skillTitle: string
  /** 任务状态。 */
  status: TAgentWorkbenchTaskStatus
  /** 任务创建时刻（毫秒时间戳，供运行中实时计时）。 */
  startedAt: number
  /**
   * 执行任务的目标执行 ID。
   *
   * 与 taskId 同值，独立成字段是为了让「内嵌执行区块」的取数不依赖
   * taskKind 的语义推断（执行总线按 executionId 索引）。
   */
  executionId?: string
  /** 终态摘要。 */
  summary?: IAgentWorkbenchTaskSummary
  /** 失败或就绪阻断时的原因摘要。 */
  errorMessage?: string
  /**
   * 产物完备性（生成任务终态时提供），供下一步动作卡片判断：
   * 缺什么补什么、齐备才给「执行测试」（PRD ID-7）。
   */
  artifacts?: {
    hasSkillDocument: boolean
    hasPlaywrightScript: boolean
  }
  /**
   * batch 专用：批次状态（v17 R4；其余 taskKind 为缺省）。
   *
   * 为什么扩字段而不是新建块种类：连续执行卡与既有执行卡**完全同构**
   * （有 running、有终态摘要、有停止、要物化），v16 已为这类卡片立下
   * 「差异只在渲染分派」的合并理由，直接复用（技术方案 §3.1）。
   */
  batchStatus?: import('./workbench-v17').TBatchStatus
  /** batch 专用：条目清单与逐条状态。 */
  items?: import('./workbench-v17').IBatchItem[]
  /** batch 专用：上限（R4b 的 10）。 */
  batchLimit?: number
}

// ---------------------------------------------------------------------------
// 4.9e 工作台报告卡片 workbench_report（v16）
// ---------------------------------------------------------------------------

/**
 * 工作台报告卡片事件（v16，PRD RPT-2/RPT-3）。
 *
 * 为什么独立成块而不是塞进 `workbench_task` 的 `summary`：执行卡片承载的是
 * **过程**（日志流、步骤进度、停止按钮），报告卡片承载的是**结果**（统计、运行
 * 时间、目标 URL、报告入口）。两者在对话流里是**平级的两张卡片**，各自有独立
 * 的生命周期——执行结束后报告卡片才出现，而执行卡片的历史内容保持不变。
 *
 * 若把结果画进执行卡片内部，会得到「卡片里再套一张卡片」的嵌套结构，且执行
 * 卡片的 footer 已经承载了失败原因，再加统计表会让一张卡片出现两个结果区。
 *
 * 与 `workbench_task` 的关系：由同一个服务端编排发布，执行卡片先出、报告卡片
 * 紧随其后（靠 seq 保证顺序）；`executionId` 把两者关联起来。
 */
export interface IAgentWorkbenchReportEvent {
  type: 'workbench_report'
  phase: 'begin'
  /** 关联的执行 ID（与执行卡片的 taskId 同值）。 */
  executionId: string
  /** 目标 SKILL。 */
  skillId: string
  /** 目标 SKILL 标题。 */
  skillTitle: string
  /**
   * 执行终态。
   *
   * 报告卡片只在该状态为终态时发布（运行中没有报告可看），
   * 因此这里不含 `'running'`。
   */
  taskStatus: Exclude<TAgentWorkbenchTaskStatus, 'running'>
  /** 统计与展示数据（PRD RPT-2 要求的统计 / 耗时 / 运行时间 / 目标 URL）。 */
  summary: IAgentWorkbenchTaskSummary
}

// ---------------------------------------------------------------------------
// 4.9d Agent 检索候选（v16）
// ---------------------------------------------------------------------------

/**
 * `/agent` 检索用的 SKILL 候选（PRD ID-3）。
 *
 * 为什么不扩 `ISkillSummary`：后者是列表 API 的 DTO，扩字段会牵动
 * `toSkillSummary` 与多处前端消费；Agent 检索需要的是「产物完备性」这一
 * 执行视角的信息，与列表展示的关注点不同，因此独立成一个面向 Agent 的类型。
 */
export interface IAgentSkillCandidate {
  /** SKILL 唯一 ID（9 位 [a-z0-9]）——/agent 中唯一合法的目标指代方式。 */
  id: string
  /** SKILL 标题。 */
  title: string
  /** SKILL 描述。 */
  description: string
  /** 是否已有 SKILL.md。 */
  hasSkillDocument: boolean
  /** 是否已有 test.spec.ts。 */
  hasPlaywrightScript: boolean
  /** 用例的目标 URL（可选，供 Agent 判断相关性）。 */
  baseUrl?: string
}

// ---------------------------------------------------------------------------
// 4.10 完整联合类型
// ---------------------------------------------------------------------------

/**
 * 块事件的载荷联合（不含信封）。
 *
 * CLI 网关发布事件时为每个载荷分配 seq 并套上信封，形成 TAgentClientEvent。
 */
export type TAgentClientEventPayload =
  | TAgentThinkingEvent
  | TAgentContentEvent
  | TAgentToolEvent
  | IAgentTodoEvent
  | TAgentCommandEvent
  | TAgentInteractionEvent
  | IAgentFileChangeEvent
  | IAgentNoticeEvent
  | TAgentTurnEvent
  | IAgentStatusEvent
  | IAgentHeartbeatEvent
  | IAgentWorkbenchActionEvent
  | IAgentWorkbenchTaskEvent
  | IAgentWorkbenchReportEvent
  | import('./workbench-v17').IAgentWorkbenchViewEvent
  | import('./workbench-v17').IAgentWorkbenchProposalEvent

/**
 * Agent 工作过程的客户端事件（信封 + 载荷）。
 *
 * 客户端渲染协议的三端唯一契约：agent 包生产载荷，cli 网关套信封分发，
 * web 客户端按 type 选择组件渲染。
 */
export type TAgentClientEvent = IAgentClientEventEnvelope &
  TAgentClientEventPayload

/**
 * 事件草稿：agent 侧翻译层产出的事件（已带 blockId / sessionId / timestamp），
 * seq 由 CLI 网关事件总线在发布时统一分配。
 */
export type TAgentClientEventDraft = TAgentClientEventPayload & {
  /** 会话 ID。 */
  sessionId: string
  /** 工作块 ID。 */
  blockId: string
  /** 事件发生时的毫秒时间戳。 */
  timestamp: number
}

// ---------------------------------------------------------------------------
// 历史块（会话恢复用物化视图）
// ---------------------------------------------------------------------------

/** 工作块的存储/展示状态。 */
export type TAgentWorkBlockStatus =
  'streaming' | 'done' | 'failed' | 'pending' | 'answered'

/**
 * 工作块种类（与时间线块事件类型一一对应）。
 *
 * v16 新增两类：`workbench_action`（动作入口）与 `workbench_task`（执行/生成任务）。
 * 表结构变更后须重建工作块库（`pnpm db:reset`）——本存储不做列迁移。
 */
export type TAgentWorkBlockKind =
  | 'thinking'
  | 'content'
  | 'tool'
  | 'todo'
  | 'command'
  | 'interaction'
  | 'notice'
  | 'turn'
  | 'workbench_action'
  | 'workbench_task'
  | 'workbench_report'
  // v17：只读视图卡与提案卡（技术方案 §4.6）。
  | 'workbench_view'
  | 'workbench_proposal'

/**
 * 物化的工作块：会话恢复接口返回的历史单元。
 *
 * payload 为按 kind 区分的当前完整状态（如 content 块含累积全文、
 * command 块含全量输出、interaction 块含回答结果），客户端直接渲染，无需重放事件。
 */
export interface IAgentWorkBlock {
  /** 所属会话 ID。 */
  sessionId: string
  /** 工作块 ID。 */
  blockId: string
  /** 块 begin 事件的 seq，即时间线排序依据。 */
  seq: number
  /** 所属轮次运行 ID。 */
  runId: string
  /** 块种类。 */
  kind: TAgentWorkBlockKind
  /** 块状态。 */
  status: TAgentWorkBlockStatus
  /** 块的完整当前内容（结构按 kind 区分）。 */
  payload: Record<string, unknown>
  /** 块创建毫秒时间戳。 */
  createdAt: number
  /** 块最近更新毫秒时间戳。 */
  updatedAt: number
}

/**
 * 会话种类。
 *
 * chat       —— 用户在 Agent 工作台主动发起的对话（进入会话列表）；
 * generation —— 平台发起的生成任务（SKILL.md / Playwright），不进会话列表。
 */
export type TAgentSessionKind = 'chat' | 'generation'

/**
 * 会话列表项：会话恢复入口。
 */
export interface IAgentSessionSummary {
  /** 会话 ID。 */
  sessionId: string
  /** 会话种类：区分用户对话与平台生成任务。 */
  kind: TAgentSessionKind
  /** 会话标题（首条用户消息截断生成）。 */
  title: string
  /** 会话当前状态。 */
  status: 'idle' | 'running' | 'waiting_user' | 'error'
  /** 创建毫秒时间戳。 */
  createdAt: number
  /** 最近活跃毫秒时间戳。 */
  updatedAt: number
}
