import { useMessage } from 'naive-ui'

/**
 * 封装全局通用的消息提示方法，统一规范展示时长。
 * @returns 包含 success 和 error 等自定义提示方法的对象。
 */
export function useGlobalMessage() {
  const message = useMessage()

  return {
    /**
     * 成功提示，至少显示 3 秒（3000ms）
     * @param content 提示文本
     */
    success(content: string) {
      return message.success(content, { duration: 3000 })
    },

    /**
     * 警告提示，显示 3 秒（3000ms）
     * @param content 提示文本
     */
    warning(content: string) {
      return message.warning(content, { duration: 3000 })
    },

    /**
     * 错误提示，显示 5 秒（5000ms）
     * @param content 提示文本
     */
    error(content: string) {
      return message.error(content, { duration: 5000 })
    },

    /**
     * 提供对 Naive UI 原生 message 实例的访问（备用）
     */
    raw: message,
  }
}
