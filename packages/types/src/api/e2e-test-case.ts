/**
 * 定义 E2E 测试用例编辑、Playwright 生成和脚本保存的 HTTP API 契约。
 */
import { z } from 'zod'
import type { IApiSuccessResponse } from './common'
import { apiErrorCodeSchema } from './common'
import {
  e2eTestCaseSchema,
  type IE2ETestCase,
  type IE2EValidationIssue,
} from '../domain/e2e-test-case'
import { fileSaveModeSchema, type IFileSaveDiagnostic } from './file-save'

export const sha256FileVersionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, '文件版本必须是 64 位 SHA-256 十六进制字符串。')

export const sourceHashSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, '源数据哈希格式不正确。')

export const updateE2ETestCaseRequestSchema = z
  .object({
    testCase: e2eTestCaseSchema,
    expectedVersion: sha256FileVersionSchema,
  })
  .strict()

export const generatePlaywrightRequestSchema = z
  .object({
    expectedTestCaseFileVersion: sha256FileVersionSchema,
    expectedScriptVersion: sha256FileVersionSchema.nullable(),
  })
  .strict()

export const savePlaywrightScriptRequestSchema = z
  .object({
    code: z
      .string()
      .min(1, 'Playwright 脚本不能为空。')
      .max(1024 * 1024),
    sourceHash: sourceHashSchema,
    expectedScriptVersion: sha256FileVersionSchema.nullable(),
    /**
     * 保存模式：
     *   generation - 生成完成首次落盘，严格校验且写入格式化后的代码；
     *   edit       - 用户实时编辑，校验仅产出诊断且写入用户原文。
     *
     * edit 模式不格式化的理由：格式化会重排用户正在编辑的代码、移动光标，
     * 每次防抖保存都会用格式化结果覆盖输入，破坏输入体验（PRD 7.3）。
     */
    mode: fileSaveModeSchema,
  })
  .strict()

export const playwrightScriptStatusSchema = z.enum([
  'not_generated',
  'current',
  'stale',
  'untracked',
])
export type TPlaywrightScriptStatus = z.infer<
  typeof playwrightScriptStatusSchema
>

export const playwrightScriptStateSchema = z
  .object({
    exists: z.boolean(),
    status: playwrightScriptStatusSchema,
    version: sha256FileVersionSchema.nullable(),
    generatedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime().nullable(),
    sourceHash: sourceHashSchema.nullable(),
  })
  .strict()
export type IPlaywrightScriptState = z.infer<typeof playwrightScriptStateSchema>

export interface IE2ETestCaseDocumentData {
  testCase: IE2ETestCase
  version: string
  sourceHash: string
  updatedAt: string
  script: IPlaywrightScriptState
  skillDocument?: import('./skill-document').ISkillDocumentState
}

export interface IUpdateE2ETestCaseRequest {
  testCase: IE2ETestCase
  expectedVersion: string
}

export interface IUpdateE2ETestCaseData extends IE2ETestCaseDocumentData {
  title: string
  description: string
}

export interface IGeneratePlaywrightRequest {
  expectedTestCaseFileVersion: string
  expectedScriptVersion: string | null
}

export const playwrightGenerationWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    severity: z.enum(['info', 'warning']),
    stepId: z.string().min(1).optional(),
  })
  .strict()
export type IPlaywrightGenerationWarning = z.infer<
  typeof playwrightGenerationWarningSchema
>
export type TPlaywrightGenerationWarningSeverity =
  IPlaywrightGenerationWarning['severity']

export const playwrightStepCoverageSchema = z
  .object({
    stepId: z.string().min(1),
    operations: z.number().int().nonnegative(),
    assertions: z.number().int().nonnegative(),
  })
  .strict()
export type IPlaywrightStepCoverage = z.infer<
  typeof playwrightStepCoverageSchema
>

export const playwrightGenerationResultSchema = z
  .object({
    code: z.string().min(1),
    warnings: z.array(playwrightGenerationWarningSchema),
    assumptions: z.array(z.string().min(1)),
    environmentVariables: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)),
    stepCoverage: z.array(playwrightStepCoverageSchema),
  })
  .strict()
export type IPlaywrightGenerationResult = z.infer<
  typeof playwrightGenerationResultSchema
>

export const generatePlaywrightDataSchema = playwrightGenerationResultSchema
  .extend({
    sourceHash: sourceHashSchema,
    testCaseVersion: sha256FileVersionSchema,
    scriptVersion: sha256FileVersionSchema.nullable(),
  })
  .strict()
export type IGeneratePlaywrightData = z.infer<
  typeof generatePlaywrightDataSchema
>

export type ISavePlaywrightScriptRequest = z.infer<
  typeof savePlaywrightScriptRequestSchema
>

export interface ISavePlaywrightScriptData {
  relativePath: 'test.spec.ts'
  version: string
  size: number
  sourceHash: string
  generatedAt: string
  updatedAt: string
  /** 校验诊断；generation 模式下为空（有 error 时请求已失败）。 */
  diagnostics: IFileSaveDiagnostic[]
}

export interface IE2EValidationErrorDetails {
  issues: IE2EValidationIssue[]
}

export const playwrightGenerationEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('start'),
      requestId: z.string().min(1),
      /**
       * 生成任务关联的 Agent 会话 ID（v7）。
       *
       * 前端据此自动展开全局侧边栏 Chat 并订阅工作事件流（PRD 7.6 / AC-09）。
       * 与 SKILL.md 生成契约保持一致：建立 SSE 流时即下发，无需等待生成完成。
       */
      sessionId: z.string().min(1),
      // v7 扩展：本次生成的浏览器模式（headed 有头调试页面 / headless 无头）
      browserMode: z.enum(['headed', 'headless']).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('progress'),
      /**
       * 生成阶段（与 PRD 6.2 页面状态对齐）。
       *
       * 本版本实现「准备生成 → 核对页面元素 → 生成候选脚本 → 检查脚本质量」；
       * 试运行与自动修复阶段在后续接入时在此追加。
       */
      stage: z.enum([
        'preparing',
        'verifying-page',
        'generating-script',
        'validating-code',
        'completed',
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal('complete'),
      data: generatePlaywrightDataSchema,
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
export type TPlaywrightGenerationEvent = z.infer<
  typeof playwrightGenerationEventSchema
>

export type IGetE2ETestCaseResponse =
  IApiSuccessResponse<IE2ETestCaseDocumentData>
export type IUpdateE2ETestCaseResponse =
  IApiSuccessResponse<IUpdateE2ETestCaseData>
export type IGeneratePlaywrightResponse =
  IApiSuccessResponse<IGeneratePlaywrightData>
export type ISavePlaywrightScriptResponse =
  IApiSuccessResponse<ISavePlaywrightScriptData>
