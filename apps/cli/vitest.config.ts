// CLI 测试配置：串行执行会修改进程级环境变量的测试文件，避免配置目录隔离互相覆盖。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 配置路径通过 process.env 解析，测试文件必须串行运行以保持环境隔离。
    fileParallelism: false,
  },
})
