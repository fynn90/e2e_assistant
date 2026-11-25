class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

Object.defineProperty(globalThis, 'ResizeObserver', {
  value: ResizeObserverMock,
  configurable: true,
})

Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: async () => undefined },
  configurable: true,
})
