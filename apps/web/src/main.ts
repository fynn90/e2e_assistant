import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
// 图标库为全局 @font-face + 全局字形类，与 style.css 同性质，统一在入口引入一次
import './assets/icons/iconfont.css'
import './style.css'

function bootstrapApplication(): void {
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)
  app.mount('#app')
}

bootstrapApplication()
