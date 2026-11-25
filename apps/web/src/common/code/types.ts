// 代码编辑器模块共享类型定义

export interface ICodeEditorProps {
  modelValue: string
  filePath: string
  language: string
  readOnly: boolean
  saving: boolean
  dirty: boolean
  saveState?: 'idle' | 'saved' | 'failed' | 'conflict'
  /** 隐藏内置工具栏（文件名与保存入口移至页面顶栏时使用） */
  hideToolbar?: boolean
}
