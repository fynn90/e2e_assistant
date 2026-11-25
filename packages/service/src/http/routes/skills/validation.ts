import {
  generatePlaywrightRequestSchema,
  generateSkillDocumentRequestSchema,
  saveSkillDocumentRequestSchema,
  savePlaywrightScriptRequestSchema,
  updateE2ETestCaseRequestSchema,
} from '@fynn90-e2e_assistant/types'
import { z } from 'zod'

export const skillIdSchema = z.string().regex(/^[a-z0-9]{9}$/)

export const createSkillSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .regex(/^[一-龥a-zA-Z0-9_-]+$/),
    description: z.string().trim().max(200).optional(),
  })
  .strict()

export const updateSkillFileSchema = z
  .object({
    relativePath: z.string().min(1).max(2048),
    content: z.string(),
    expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export const updateE2ETestCaseSchema = updateE2ETestCaseRequestSchema
export const generatePlaywrightSchema = generatePlaywrightRequestSchema
export const savePlaywrightScriptSchema = savePlaywrightScriptRequestSchema

/**
 * 在 userWorkSpace 内新建目录的请求体（v14 D1/W14）。
 *
 * path 是 userWorkSpace 内相对路径（不含 userWorkSpace 前缀，服务端拼接根）；
 * 段级合法性（拒绝绝对路径/`..`/反斜杠/重复 userWorkSpace 段）由 skill-manager
 * 的归一化函数最终把关，此处只做长度与基本形状约束。
 */
export const createUserWorkspaceDirectorySchema = z
  .object({
    path: z.string().trim().min(1).max(2048),
  })
  .strict()

/**
 * 在 userWorkSpace 内新建文件的请求体（v14 D1/W14；创建语义，不覆盖已有文件）。
 */
export const createUserWorkspaceFileSchema = z
  .object({
    path: z.string().trim().min(1).max(2048),
    content: z.string(),
  })
  .strict()

/**
 * 单条 Chat 消息的最大字符数。
 *
 * v12-pre：与 Web 端 `common/chat/limits.ts` 的 CHAT_MAX_MESSAGE_CHARACTERS 及
 * agent 端 skill-chat 的 MAX_MESSAGE_CHARACTERS 保持一致；页面核对阶段产生的
 * 长文本（页面快照）会随会话历史流转，三者不一致会让客户端放行、服务端拒收。
 */
const SKILL_CHAT_MAX_MESSAGE_CHARACTERS = 240_000

/** Chat 历史总字符上限，保持为单条上限的 3 倍。 */
const SKILL_CHAT_MAX_HISTORY_CHARACTERS = 720_000

export const skillChatSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(SKILL_CHAT_MAX_MESSAGE_CHARACTERS),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    currentFile: z
      .object({
        relativePath: z.string().min(1).max(2048),
        version: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.messages.reduce(
        (total, message) => total + message.content.length,
        0,
      ) <= SKILL_CHAT_MAX_HISTORY_CHARACTERS,
    { message: 'Chat 消息总长度超过限制。' },
  )

/** 导出供路由层推导请求体上限，避免字数与字节数两处各自硬编码。 */
export const skillChatLimits = {
  maxMessageCharacters: SKILL_CHAT_MAX_MESSAGE_CHARACTERS,
  maxHistoryCharacters: SKILL_CHAT_MAX_HISTORY_CHARACTERS,
} as const

export const generateSkillDocumentSchema = generateSkillDocumentRequestSchema
export const saveSkillDocumentSchema = saveSkillDocumentRequestSchema
