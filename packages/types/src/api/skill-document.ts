/**
 * 定义 SKILL.md 生成、校验、状态查询和确认保存的跨包 API 契约。
 */
import { z } from 'zod'
import type { IApiSuccessResponse } from './common'
import { apiErrorCodeSchema } from './common'
import { fileSaveModeSchema, type IFileSaveDiagnostic } from './file-save'

export const SKILL_DOCUMENT_FILE_NAME = 'SKILL.md' as const

export const skillDocumentStatusSchema = z.enum([
  'not_generated',
  'current',
  'stale',
  'untracked',
  'read_only',
])
export type TSkillDocumentStatus = z.infer<typeof skillDocumentStatusSchema>

export const skillDocumentStateSchema = z
  .object({
    exists: z.boolean(),
    status: skillDocumentStatusSchema,
    version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    generatedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
    sourceHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict()
export type ISkillDocumentState = z.infer<typeof skillDocumentStateSchema>

export const generateSkillDocumentRequestSchema = z
  .object({
    expectedTestCaseFileVersion: z.string().regex(/^[a-f0-9]{64}$/),
    expectedSkillDocumentVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict()
export type IGenerateSkillDocumentRequest = z.infer<
  typeof generateSkillDocumentRequestSchema
>

export const skillDocumentWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(['info', 'warning']),
    stepId: z.string().min(1).optional(),
  })
  .strict()
export type ISkillDocumentWarning = z.infer<typeof skillDocumentWarningSchema>

export const skillDocumentGenerationResultSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(1024 * 1024),
    warnings: z.array(skillDocumentWarningSchema),
    assumptions: z.array(z.string().min(1)),
    environmentVariables: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)),
    sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    testCaseVersion: z.string().regex(/^[a-f0-9]{64}$/),
    skillDocumentVersion: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type ISkillDocumentGenerationResult = z.infer<
  typeof skillDocumentGenerationResultSchema
>

export const saveSkillDocumentRequestSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(1024 * 1024),
    sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expectedSkillDocumentVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    /**
     * 保存模式：
     *   generation - 生成完成首次落盘，严格校验，失败阻断；
     *   edit       - 用户实时编辑，校验仅产出诊断，不阻断写入。
     */
    mode: fileSaveModeSchema,
  })
  .strict()
export type ISaveSkillDocumentRequest = z.infer<
  typeof saveSkillDocumentRequestSchema
>

export interface ISaveSkillDocumentData {
  relativePath: typeof SKILL_DOCUMENT_FILE_NAME
  version: string
  size: number
  sourceHash: string
  generatedAt: string
  updatedAt: string
  /** 校验诊断；generation 模式下为空（有 error 时请求已失败）。 */
  diagnostics: IFileSaveDiagnostic[]
}

export interface ISkillDocumentData {
  content: string
  version: string
  size: number
  updatedAt: string
}

export const skillDocumentGenerationEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('start'),
      requestId: z.string().min(1),
      /** 本次生成任务对应的 Agent 会话 ID：前端据此订阅工作事件流。 */
      sessionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('progress'),
      stage: z.enum([
        'requesting-model',
        'writing-skill',
        'repairing-output',
        'validating-output',
        'completed',
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal('complete'),
      data: skillDocumentGenerationResultSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('error'),
      code: apiErrorCodeSchema,
      message: z.string().min(1),
    })
    .strict(),
])
export type TSkillDocumentGenerationEvent = z.infer<
  typeof skillDocumentGenerationEventSchema
>

export type IGenerateSkillDocumentResponse =
  IApiSuccessResponse<ISkillDocumentGenerationResult>
export type ISaveSkillDocumentResponse =
  IApiSuccessResponse<ISaveSkillDocumentData>
