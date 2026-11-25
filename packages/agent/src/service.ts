/**
 * @authine-e2e-agent/agent 对外暴露的会话服务，提供给 CLI、Web 使用。
 *
 * AgentService 是多轮会话编排的门面：持有共享模型运行时与会话存储，
 * 统一通过 chat 方法接入「一个会话多轮对话」模型；Skill 的选择和具体任务
 * 由客户端通过 prompt 触发，避免在服务层维护重复的业务入口。
 */

import { resolve } from 'node:path'
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core'
import type { IModelInfo } from './types'
import { createAgentModelRuntime, type IAgentModelRuntime } from './model'
import { AgentFactory } from './agents/factory'
import { AgentTaskRunner } from './task/task-runner'
import type { IAgentTaskHandle } from './task/types'
import { createSqliteSessionStore } from './session/sqlite'
import type { ISessionStore } from './harness/interfaces'
import {
  createE2EChat,
  type IChatHandle,
  type IChatOptions,
} from './service/chat'

/**
 * 会话数据库相对工作区的默认存放目录。
 */
const DEFAULT_SESSION_DIR = '.e2e-agent'

/**
 * AgentService 构造选项。
 */
export interface IAgentServiceOptions {
  /** 会话存储；缺省为 sqlite（见 sessionDbPath）。 */
  sessionStore?: ISessionStore
  /** 会话数据库路径；仅当未显式传入 sessionStore 时生效，缺省为 <workspace>/.e2e-agent/sessions.db。 */
  sessionDbPath?: string
  /** 复用外部模型运行时；缺省由 AgentService 基于 modelInfo 创建。 */
  modelRuntime?: IAgentModelRuntime
  /** 透传给配置工厂的额外工具（v11：Skill Chat 注入 execute_test 等）；缺省不追加。 */
  extraTools?: import('@earendil-works/pi-agent-core').AgentTool<any>[]
  /** 透传给配置工厂的 bash 可执行文件绝对路径；缺省由 NodeExecutionEnv 按平台默认规则探测。 */
  shellPath?: string
}

/**
 * AgentService：面向 CLI / Web 的会话级多轮对话服务。
 *
 * 一个会话（sessionId）对应一个 AgentLoop 与一份持久化历史；chat 方法返回
 * 任务句柄，句柄支持 send 续轮，会话在显式 removeTask / dispose 前保持打开。
 */
export class AgentService {
  /** 工作目录：所有 Agent 文件操作与 Shell 命令的默认解析根目录。 */
  readonly workspace: string

  /** 模型配置（名称、地址、密钥与思考能力）。 */
  modelInfo: IModelInfo = {
    name: '',
    url: '',
    key: '',
    thinkingLevel: 'max',
    supportsThinking: true,
  }

  /** 共享模型运行时。 */
  private readonly modelRuntime: IAgentModelRuntime

  /** 共享会话存储：任务历史持久化与断点续跑的兜底实现。 */
  private readonly sessionStore: ISessionStore

  /** 是否由本服务创建会话存储（为 true 时 dispose 负责关闭）。 */
  private readonly ownsSessionStore: boolean

  /** 多轮任务运行器。 */
  private readonly runner: AgentTaskRunner

  /**
   * 创建会话服务并初始化模型、会话存储和任务运行器。
   *
   * @param workspace - Agent 操作目录，作为文件操作和 Shell 命令的默认解析根目录。
   * @param modelInfo - 模型名称、API 根地址、密钥与思考能力配置。
   * @param options - 可选配置：会话存储、会话数据库路径、共享模型运行时、
   *   额外工具与 bash 可执行文件路径。
   * @throws {Error} 当 workspace 为空时抛出。
   */
  constructor(
    workspace: string,
    modelInfo: IModelInfo,
    options: IAgentServiceOptions = {},
  ) {
    if (workspace.trim().length === 0) {
      throw new Error('workspace 不能为空')
    }
    this.workspace = workspace
    // 保留旧版默认：未声明思考能力时按支持 thinking 处理。
    this.modelInfo = { ...this.modelInfo, ...modelInfo }

    this.modelRuntime =
      options.modelRuntime ?? createAgentModelRuntime(this.modelInfo)
    this.sessionStore =
      options.sessionStore ??
      createSqliteSessionStore({
        dbPath: options.sessionDbPath ?? defaultSessionDbPath(workspace),
      })
    this.ownsSessionStore = options.sessionStore === undefined

    this.runner = new AgentTaskRunner({
      // sessionId 透传给配置工厂：生成任务据此获得浏览器工具（v7 页面核对）；
      // extraTools 透传：Skill Chat 据此获得 execute_test 工具（v11）；
      // shellPath 透传：bash 工具使用 CLI 启动时探测到的可执行文件路径。
      configFactory: (
        operateType,
        workspaceCwd,
        sessionId,
        extraTools,
        shellPath,
        workbench,
      ) =>
        AgentFactory(
          operateType,
          workspaceCwd,
          sessionId,
          extraTools,
          shellPath,
          workbench,
        ),
      workspace,
      modelRuntime: this.modelRuntime,
      sessionStore: this.sessionStore,
      ...(options.extraTools ? { extraTools: options.extraTools } : {}),
      ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    })
  }

  /**
   * 发起对话任务；客户端可在 prompt 中要求 Agent 加载指定 Skill。
   *
   * @param prompt - 用户输入文本或一条/多条 AgentMessage 消息，作为首轮的启动内容。
   * @param options - 可选配置：sessionId、操作类型（chat / workbench）、Harness
   *   插件集合、系统提示词覆盖，以及工作台会话的能力装配。
   * @returns 已自动启动首轮的任务句柄。
   */
  chat(prompt: string | AgentMessage[], options?: IChatOptions): IChatHandle {
    return createE2EChat(this.runner, prompt, options)
  }

  /**
   * 查询指定任务句柄。
   *
   * @param sessionId - 会话 ID。
   * @returns 任务句柄；不存在返回 undefined。
   */
  getTask<TAppEvent = AgentEvent>(
    sessionId: string,
  ): IAgentTaskHandle<TAppEvent> | undefined {
    return this.runner.getTask(sessionId) as
      IAgentTaskHandle<TAppEvent> | undefined
  }

  /**
   * 列出当前所有任务句柄。
   *
   * @returns 任务句柄数组。
   */
  listTasks(): IAgentTaskHandle[] {
    return this.runner.listTasks()
  }

  /**
   * 移除并释放指定会话。
   *
   * @param sessionId - 会话 ID。
   * @returns 会话释放完成的 Promise。
   */
  removeTask(sessionId: string): Promise<void> {
    return this.runner.removeTask(sessionId)
  }

  /**
   * 释放全部会话与自建资源（关闭自建会话存储连接）。
   *
   * @returns 所有会话和资源释放完成的 Promise。
   */
  async dispose(): Promise<void> {
    await Promise.all(this.listTasks().map((task) => task.dispose()))
    if (this.ownsSessionStore) {
      const store = this.sessionStore as ISessionStore & {
        close?: () => void
      }
      store.close?.()
    }
  }
}

/**
 * 计算默认会话数据库路径：工作区下的 .e2e-agent/sessions.db。
 *
 * @param workspace - Agent 工作目录。
 * @returns 会话数据库绝对路径。
 */
function defaultSessionDbPath(workspace: string): string {
  return resolve(workspace, DEFAULT_SESSION_DIR, 'sessions.db')
}
