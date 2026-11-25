/**
 * 配置 Web 工作台开发服务器、CLI API 代理和生产构建分包。
 */
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const cliPort = process.env.AUTHINE_CLI_PORT ?? '5826'
const cliTarget = `http://127.0.0.1:${cliPort}`
const webPort = Number(process.env.AUTHINE_WEB_PORT ?? '5176')
const printDevelopmentUrlPlugin = {
  name: 'authine-print-development-url',
  configureServer(server) {
    server.httpServer?.once('listening', () => {
      const developmentUrl = server.resolvedUrls?.local[0]

      if (developmentUrl) {
        console.log(
          `\n  🚀【web】 @authine-e2e-agent/web hot reload: ${developmentUrl}`,
        )
        console.log(`  🚀【web】 CLI API proxy: ${cliTarget}`)
      }
    })
  },
} satisfies Plugin

export default defineConfig({
  plugins: [vue(), printDevelopmentUrlPlugin],
  define: {
    __AUTHINE_CLI_PORT__: JSON.stringify(cliPort),
  },
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: cliTarget },
      '/health': { target: cliTarget },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('monaco-editor')) return 'monaco-editor'
          if (id.includes('markdown-it') || id.includes('dompurify'))
            return 'chat-markdown'
          return undefined
        },
      },
    },
  },
})
