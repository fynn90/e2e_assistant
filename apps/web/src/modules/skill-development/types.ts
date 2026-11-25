/**
 * 定义 Skill 开发页状态、编辑资源与路由工作区组件协调契约。
 */
import type { ComputedRef, Ref, WritableComputedRef } from 'vue'
import type {
  IEnvFileIssue,
  IFileSaveDiagnostic,
  ISkillDetail,
  ISkillFileContent,
  ISkillFileTreeNode,
} from '@charlie_deng/e2e-assistant-types'
import type { IChatMessageViewModel } from '../../common/chat/types'
import type { TAutoSaveState } from '../../common/autosave/types'

export type TSkillDevelopmentPageState =
  | 'loading'
  | 'ready'
  | 'invalid-id'
  | 'not-found'
  | 'corrupted'
  | 'permission-denied'
  | 'service-unavailable'
  | 'error'

export interface ICurrentSkillFile extends ISkillFileContent {
  savedContent: string
  draftContent: string
  orphaned: boolean
}

/**
 * env.json 最新合法状态的只读视图（v10，PRD 6.1.5 / 7.3）。
 *
 * 数据源是磁盘上最近一次合法内容：格式非法（保存被阻止）期间 keys 维持
 * 上一次合法值，不把编辑中的半成品暴露给用例编辑页。
 */
export interface ISkillEnvFileState {
  /** 读取状态；只读 Skill 缺失 env.json 时同样表现为 missing。 */
  status: Ref<'loading' | 'ok' | 'missing' | 'invalid'>
  /** 合法时的全部 key（字母序）；驱动敏感数据下拉与插入引用下拉。 */
  keys: ComputedRef<string[]>
  /** 格式错误明细（invalid 时），供用例页与 env 编辑页提示复用。 */
  issues: Ref<IEnvFileIssue[]>
  /** 重新拉取（进入结构化面板、env.json 保存成功后由 store 调用）。 */
  refresh (): Promise<void>
}

export interface IChatPanelHandle {
  focusComposer (): void
}

/** 页头状态标签描述：由工作区面板提供，页头统一渲染 */
export interface IHeaderStatusTag {
  /** 标签唯一标识，用于列表渲染 key */
  key: string
  /** 标签文本 */
  label: string
  /** 标签类型，映射 naive-ui NTag 的 type */
  type: 'default' | 'success' | 'warning' | 'error' | 'info'
  /** 悬浮提示文本（可选） */
  title?: string
}

/** 页头操作按钮描述：由工作区面板提供，页头统一渲染 */
export interface IHeaderActionItem {
  /** 按钮唯一标识，用于列表渲染 key */
  key: string
  /** 按钮文本 */
  label: string
  /** 是否主要按钮 */
  primary: boolean
  /** 是否次要样式 */
  secondary: boolean
  /** 是否加载中 */
  loading: boolean
  /** 是否允许点击 */
  enabled: boolean
  /** 点击回调 */
  run: () => void
}

export interface IStructuredEditorHandle {
  save (): Promise<boolean>
  discard (): void
  reload (): Promise<boolean>
  markSourceMissing (): void
  /** 页头副标题（结构化用例固定文件名） */
  readonly toolbarSubtitle: string
  /** 页头状态标签，随编辑器状态响应式更新（组件实例上的 ComputedRef 已解包为数组） */
  readonly toolbarTags: IHeaderStatusTag[]
  /** 页头操作按钮（保存/生成），随就绪状态响应式更新（组件实例上的 ComputedRef 已解包为数组） */
  readonly toolbarActions: IHeaderActionItem[]
  getSavedFileContext (): { relativePath: string; version: string } | undefined
}

export interface ISkillDevelopmentWorkspaceContext {
  skill: Ref<ISkillDetail | null>
  currentFile: Ref<ICurrentSkillFile | null>
  draftContent: WritableComputedRef<string>
  chatDraft: Ref<string>
  messages: Ref<IChatMessageViewModel[]>
  streaming: Ref<boolean>
  dirty: ComputedRef<boolean>
  saving: Ref<boolean>
  saveState: Ref<'idle' | 'saved' | 'failed' | 'conflict'>
  /** 实时保存状态（保存状态徽标数据源，PRD 7.4）。 */
  autoSaveState: Ref<TAutoSaveState>
  /** 实时保存的校验诊断；edit 模式下不阻断写入，仅提示。 */
  autoSaveDiagnostics: Ref<readonly IFileSaveDiagnostic[]>
  /** 实时保存的校验阻断问题明细（blocked 态专属呈现，v10 PRD 5.3）。 */
  autoSaveBlockedIssues: Ref<IEnvFileIssue[]>
  /** 实时保存错误文案（错误条展示）。 */
  autoSaveErrorMessage: Ref<string>
  /** env.json 最新合法状态（下拉数据源、失效判定与格式错误提示，v10）。 */
  envFileState: ISkillEnvFileState
  /** 用户点击「重试保存」。 */
  retryAutoSave (): Promise<boolean>
  /** 用户点击「重新加载」：放弃本地改动，用磁盘内容覆盖。 */
  reloadAutoSave (): Promise<void>
  chatReady: ComputedRef<boolean>
  showOnboardingCaseHint: ComputedRef<boolean>
  requestSend (content: string): void
  stopChat (): void
  retryChat (messageId: string): Promise<void>
  saveCurrentFile (): Promise<boolean>
  openRawE2ETestCase (): Promise<void>
  /** 刷新文件树；返回是否刷新成功（被中止或失败时为 false） */
  refreshTree (): Promise<boolean>
  setStructuredDirty (value: boolean): void
  updateSkillProjection (data: { title: string; description: string }): void
  recordCaseReady (skillId: string): void
  recordReviewedScriptSaved (skillId: string): void
  registerChatPanel (handle: IChatPanelHandle | null): void
  registerStructuredEditor (handle: IStructuredEditorHandle | null): void
}

export type TSkillFileNode = Extract<ISkillFileTreeNode, { kind: 'file' }>
