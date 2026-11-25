interface IBuildStorageAccessErrorOptions {
  actionLabel: string
  targetPath: string
  error: unknown
}

/**
 * 将底层文件系统权限错误转换为更易理解的业务错误。
 * @param options 存储错误转换参数。
 * @returns 面向 CLI 用户的可读错误对象。
 */
export function buildStorageAccessError(
  options: IBuildStorageAccessErrorOptions,
): Error {
  if (isPermissionError(options.error)) {
    return new Error(
      `无法${options.actionLabel} ${options.targetPath}，请检查当前用户对固定配置目录的读写权限。`,
    )
  }

  if (options.error instanceof Error) {
    return options.error
  }

  return new Error(`无法${options.actionLabel} ${options.targetPath}。`)
}

/**
 * 判断错误是否为常见的权限不足错误。
 * @param error 待判断的异常对象。
 * @returns 权限不足时返回 `true`。
 */
function isPermissionError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ((error as { code?: string }).code === 'EACCES' ||
      (error as { code?: string }).code === 'EPERM'),
  )
}
