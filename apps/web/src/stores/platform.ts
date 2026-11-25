import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  IConfigSummary,
  IInitializeConfigRequest,
  IUpdateConfigRequest,
  TConfigIssue,
} from '@charlie_deng/e2e-assistant-types'
import {
  fetchConfigStatus,
  fetchLocalServiceHealth,
  submitInitialization,
  updatePlatformConfig,
} from '../services/platform-api'
import { ApiClientError } from '../services/http-client'

export type TPlatformPageState =
  'loading' | 'uninitialized' | 'corrupted' | 'ready' | 'service-unavailable'

export const usePlatformStore = defineStore('platform', () => {
  const pageState = ref<TPlatformPageState>('loading')
  const configPath = ref('')
  const configSummary = ref<IConfigSummary | null>(null)
  const workspaceReady = ref(false)
  const chatReady = ref(false)
  const issues = ref<TConfigIssue[]>([])
  const errorMessage = ref('')
  const submitting = ref(false)
  const formModel = reactive<IInitializeConfigRequest>({
    projectDirectory: '',
    llmApiKey: '',
    llmApiBaseUrl: '',
    llmModelName: '',
  })
  const initialized = computed(() => pageState.value === 'ready')

  async function bootstrap (): Promise<void> {
    pageState.value = 'loading'
    errorMessage.value = ''

    try {
      await fetchLocalServiceHealth()
      const response = await fetchConfigStatus()
      applyConfigData(response.data)
    } catch (error) {
      pageState.value = 'service-unavailable'
      errorMessage.value = getErrorMessage(error, '加载本地 CLI 服务失败。')
    }
  }

  async function initialize (): Promise<boolean> {
    submitting.value = true
    errorMessage.value = ''

    try {
      const response = await submitInitialization({ ...formModel })
      applyMutationData(response.data)
      formModel.llmApiKey = ''
      pageState.value = 'ready'
      return true
    } catch (error) {
      errorMessage.value = getErrorMessage(error, '初始化失败，请稍后重试。')
      return false
    } finally {
      submitting.value = false
    }
  }

  async function update (payload?: IUpdateConfigRequest): Promise<boolean> {
    submitting.value = true
    errorMessage.value = ''

    try {
      const response = await updatePlatformConfig(
        payload ?? {
          projectDirectory: formModel.projectDirectory,
          llmApiKey: formModel.llmApiKey,
          llmApiBaseUrl: formModel.llmApiBaseUrl,
          llmModelName: formModel.llmModelName,
        },
      )
      applyMutationData(response.data)
      formModel.llmApiKey = ''
      pageState.value = 'ready'
      return true
    } catch (error) {
      errorMessage.value = getErrorMessage(error, '保存配置失败，请稍后重试。')
      return false
    } finally {
      submitting.value = false
    }
  }

  function clearError (): void {
    errorMessage.value = ''
  }

  function populateFormFromSummary (): void {
    if (!configSummary.value) {
      return
    }

    formModel.projectDirectory = configSummary.value.projectDirectory
    formModel.llmApiKey = ''
    formModel.llmApiBaseUrl = configSummary.value.llmApiBaseUrl
    formModel.llmModelName = configSummary.value.llmModelName
  }

  function applyConfigData (
    data: Awaited<ReturnType<typeof fetchConfigStatus>>['data'],
  ): void {
    configPath.value = data.configPath

    if (data.state === 'uninitialized') {
      pageState.value = 'uninitialized'
      configSummary.value = null
      workspaceReady.value = false
      chatReady.value = false
      issues.value = []
      return
    }

    if (data.state === 'corrupted') {
      pageState.value = 'corrupted'
      configSummary.value = null
      workspaceReady.value = false
      chatReady.value = false
      issues.value = []
      return
    }

    configSummary.value = data.configSummary
    workspaceReady.value = data.workspaceReady
    chatReady.value = data.chatReady
    issues.value = data.issues
    populateFormFromSummary()
    pageState.value = data.workspaceReady ? 'ready' : 'corrupted'
  }

  function applyMutationData (data: {
    configPath: string
    configSummary: IConfigSummary
    workspaceReady: boolean
    chatReady: boolean
    issues: TConfigIssue[]
  }): void {
    configPath.value = data.configPath
    configSummary.value = data.configSummary
    workspaceReady.value = data.workspaceReady
    chatReady.value = data.chatReady
    issues.value = data.issues
    populateFormFromSummary()
  }

  return {
    pageState,
    configPath,
    configSummary,
    workspaceReady,
    chatReady,
    issues,
    errorMessage,
    submitting,
    formModel,
    initialized,
    bootstrap,
    initialize,
    update,
    clearError,
    populateFormFromSummary,
  }
})

function getErrorMessage (error: unknown, fallback: string): string {
  if (error instanceof ApiClientError || error instanceof Error) {
    return error.message || fallback
  }

  return fallback
}
