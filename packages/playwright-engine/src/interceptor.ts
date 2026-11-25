export interface IRuntimeEvent {
  type: 'console' | 'network' | 'error'
  message: string
}

export function createRuntimeEvent(
  type: IRuntimeEvent['type'],
  message: string,
): IRuntimeEvent {
  return { type, message }
}
