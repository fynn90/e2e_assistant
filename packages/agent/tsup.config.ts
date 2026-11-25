/**
 * tsup 构建配置。
 *
 * 声明 `.md` 文件的 text loader，使资源加载器能以 `?raw` 后缀
 * 把 markdown 文件原始文本内联进构建产物（配合 src/env.d.ts 的类型声明）。
 * 入口、输出格式等仍由命令行参数提供。
 */
import { defineConfig } from 'tsup'

export default defineConfig({
  loader: {
    '.md': 'text',
  },
})
