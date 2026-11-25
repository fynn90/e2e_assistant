/**
 * AskUserQuestion 宿主注册表：把「某个会话当前可用的发问宿主」暴露给 Agent 配置工厂。
 *
 * 与 browser-session-registry 同构的依赖倒转（F15 模式）：
 *   - `ask_user_question` 是普通 AgentTool，在会话创建时装配进工具列表，
 *     但提问链路（CLI 的 ask host：交互注册表、事件总线、前端卡片）的生命周期
 *     由 CLI 的 agent-work 运行时拥有；
 *   - 两者唯一能对齐的是 sessionId：任务运行器构建 Agent 配置时传入它。
 * 因此本模块用 sessionId 作为接缝：CLI 在会话创建时 register，
 * 会话释放时 unregister；配置工厂据此决定是否注入发问工具。
 *
 * 提问能力是**通用的**：Agent 在任何缺少关键信息、存在多种合理解释或没有把握的
 * 时刻都可以发问。平台不预设提问主题，也不校验答案的领域语义——路径规则、
 * 默认值取舍等约束由各 Skill 指令承载（模型自行遵守），平台只负责卡片形态、
 * 回答收集与会话中止的处理。
 *
 * 未登记宿主的会话（如 Skill 开发页 Chat，没有双向交互通道）不获得提问工具——
 * 工具缺席时模型退化为在回复文本中直接提问，不会调用不存在的工具。
 *
 * 阻塞语义：提问卡片不提供取消出口，用户必须给出回答，Agent 才能继续下一轮工作。
 * 唯一的退出方式是会话中止或客户端断开（等待被中断、工具以失败告终）。因此
 * `cancelled` 只来自异常路径（回答格式与形态不符、回答为空、回答 API 直调），
 * 不代表用户主动拒绝。
 */

/** Agent 收到的单题回答（与 questions 顺序一一对应）。 */
export interface IAskUserAnswer {
  /** 问题文案，原样回传，便于模型在多题场景对齐答案。 */
  label: string
  /** 用户的选择：所选选项的 value，或选「其它」时填写的自定义文本。 */
  value: string
}

/** ask_user_question 工具返回的结构化执行详情。 */
export interface AskUserQuestionDetails {
  /** 用户已作答（answered），或未拿到可用回答（cancelled，仅异常路径）。 */
  status: 'answered' | 'cancelled'
  /** 未拿到回答的原因（非法输入兜底等场景向模型说明，仅 status='cancelled' 时存在）。 */
  reason?: string
  /**
   * 逐题回答，顺序与 questions 一致。
   * status='cancelled' 时为空数组（无部分答案可用）。
   */
  answers: IAskUserAnswer[]
}

/** Agent 分析给出的单个问题（候选项由 Agent 传入，平台校验并追加「其它」）。 */
export interface IAskUserQuestionItem {
  /** 问题文案，如「基准目录」「需要覆盖哪些浏览器」。 */
  label: string
  /** 候选项 2-5 项（不含「其它」，数量由工具 schema 硬校验）。 */
  options: Array<{
    /** 展示文案。 */
    label: string
    /** 选项值：用户选择后回传给 Agent 的原始字符串，语义由 Agent 与 Skill 约定。 */
    value: string
    /** 补充说明。 */
    description?: string
  }>
}

/** 宿主端口：CLI 的 ask host 实现（负责校验问题结构、组装卡片、等待并回传回答）。 */
export interface IAskUserHost {
  /**
   * 发起一次阻塞式提问。
   *
   * @param input - 卡片标题、提问说明、问题与候选项。
   * @returns 归一化后的提问结果（answered 含逐题回答；cancelled 表示未拿到可用回答）。
   * @throws 宿主实现可在问题结构不合法（候选为空、Agent 自带「其它」）时抛错，
   *   向模型返回明确错误以自修复，不产生用户侧坏卡片。
   */
  ask(input: {
    /** 卡片标题；缺省时宿主用平台默认标题。 */
    title?: string
    /** Agent 分析给出的问题与候选项（1-4 项，数量由工具 schema 硬校验）。 */
    questions: IAskUserQuestionItem[]
    /** 提问说明：向用户解释为什么需要补充这些信息（展示在卡片 description）。 */
    context: string
  }): Promise<AskUserQuestionDetails>
}

/**
 * AskUserQuestion 宿主注册表接口。
 *
 * 实现必须是进程内单例语义：同一 sessionId 的注册与查询发生在不同调用栈
 * （CLI 运行时注册，Agent 配置工厂查询），因此不能依赖请求级作用域。
 */
export interface IAskUserRegistry {
  /**
   * 为指定会话登记发问宿主。
   *
   * @param sessionId - 会话 ID（与 SSE start 事件下发的一致）。
   * @param host - 已就绪的发问宿主。
   * @returns 无返回值；同一 sessionId 重复注册会覆盖旧值。
   * @throws 不抛出异常。
   */
  register(sessionId: string, host: IAskUserHost): void
  /**
   * 查询指定会话的发问宿主。
   *
   * @param sessionId - 会话 ID。
   * @returns 已登记的宿主；未登记时返回 undefined。
   * @throws 不抛出异常。
   */
  get(sessionId: string): IAskUserHost | undefined
  /**
   * 注销指定会话的发问宿主。
   *
   * @param sessionId - 会话 ID。
   * @returns 无返回值；未登记时安全无操作。
   * @throws 不抛出异常。
   */
  unregister(sessionId: string): void
}

/**
 * 创建进程内 AskUserQuestion 宿主注册表。
 *
 * @returns 可供 CLI 运行时与 Agent 配置工厂共享的注册表实例。
 * @throws 不抛出异常。
 */
export function createAskUserRegistry(): IAskUserRegistry {
  const hosts = new Map<string, IAskUserHost>()

  return {
    register(sessionId: string, host: IAskUserHost): void {
      hosts.set(sessionId, host)
    },

    get(sessionId: string): IAskUserHost | undefined {
      return hosts.get(sessionId)
    },

    unregister(sessionId: string): void {
      // 会话释放后必须注销：否则同 ID 会话复活时会拿到已释放的宿主。
      hosts.delete(sessionId)
    },
  }
}

/**
 * 默认注册表：由 Agent 配置工厂在装配工具时查询。
 *
 * 平台内只有 CLI 一个消费方，且注册与查询跨越不同模块，
 * 因此使用模块级单例而非参数传递；测试可通过 createAskUserRegistry
 * 构造独立实例，或直接向本单例注册后清理。
 */
export const askUserRegistry: IAskUserRegistry = createAskUserRegistry()
