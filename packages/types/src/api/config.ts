import type { IApiSuccessResponse } from './common'

export interface IConfigSummary {
  projectDirectory: string
  llmApiKeyMasked: string
  llmApiBaseUrl: string
  llmModelName: string
  createdAt: string
  updatedAt: string
}

export type TPlatformConfigState = 'uninitialized' | 'corrupted' | 'configured'

export type TConfigIssue =
  | 'PROJECT_DIRECTORY_MISSING'
  | 'PROJECT_DIRECTORY_UNAVAILABLE'
  | 'LLM_API_KEY_MISSING'
  | 'LLM_API_BASE_URL_INVALID'
  | 'LLM_MODEL_NAME_MISSING'

export type IGetConfigData =
  | {
      state: 'uninitialized'
      configPath: string
    }
  | {
      state: 'corrupted'
      configPath: string
    }
  | {
      state: 'configured'
      configPath: string
      configSummary: IConfigSummary
      workspaceReady: boolean
      chatReady: boolean
      issues: TConfigIssue[]
    }

export type IGetConfigResponse = IApiSuccessResponse<IGetConfigData>

export interface IInitializeConfigRequest {
  projectDirectory: string
  llmApiKey: string
  llmApiBaseUrl: string
  llmModelName: string
}

export interface IUpdateConfigRequest {
  projectDirectory: string
  llmApiKey?: string
  llmApiBaseUrl: string
  llmModelName: string
}

export interface IConfigMutationData {
  message: string
  configPath: string
  configSummary: IConfigSummary
  workspaceReady: boolean
  chatReady: boolean
  issues: TConfigIssue[]
}

export type IInitializeConfigSuccessResponse =
  IApiSuccessResponse<IConfigMutationData>
export type IUpdateConfigResponse = IApiSuccessResponse<IConfigMutationData>
