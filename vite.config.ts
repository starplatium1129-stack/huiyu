import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createProxyMiddleware } from 'http-proxy-middleware'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'

const runtimeRequire = createRequire(import.meta.url)

/** Resolve the cache-busting version at build time without editing a source store. */
function dataVersionPlugin(): Plugin {
  const virtualId = 'virtual:data-version'
  const resolvedId = '\0' + virtualId
  return {
    name: 'virtual-data-version',
    resolveId(id) { return id === virtualId ? resolvedId : undefined },
    load(id) {
      if (id !== resolvedId) return undefined
      const root = process.cwd()
      // Fresh checkouts do not carry ignored aggregate products. Rebuild only
      // missing products here; stale products remain the responsibility of the
      // content gate and are never silently corrected by a read-only check.
      runtimeRequire('./scripts/lib/ensure-data-build.js').ensureAll({ onlyIfMissing: true })
      const version = runtimeRequire('./scripts/lib/data-version.js').expectedDataVersion(root)
      return `export const DATA_VERSION = ${version}\n`
    },
  }
}

// Express 默认运行在 3000 端口；Vite dev server 在 5173
// 生产时 Express 直接 serve dist/
export default defineConfig(async ({ mode }) => {
  const plugins = [
    vue(),
    dataVersionPlugin(),
    // /assets/ 两头都要服务：SFC 模板里的 /assets/*.svg 会被 plugin-vue 改写成
    // 模块导入（?import），必须由 Vite 转换成 JS；其余（角色立绘等大文件）仍由
    // Express 提供。写进 proxy 表会把 ?import 请求也转给 Express，返回
    // image/svg+xml 触发模块 MIME 检查失败，dev 模式整条路由链路挂掉。
    {
      name: 'express-assets-conditional-proxy',
      configureServer(server) {
        server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
          const url = req.url ?? ''
          // JSON module imports must reach Vite; runtime data still comes from the gateway.
          if ((!url.startsWith('/assets/') && !url.startsWith('/data/')) || new URL(url, 'http://localhost').searchParams.has('import')) return next()
          return createProxyMiddleware({
            target: 'http://127.0.0.1:3000',
            changeOrigin: true
          })(req, res, next)
        })
      }
    } satisfies Plugin
  ]
  if (mode === 'analyze') {
    const { visualizer } = await import('rollup-plugin-visualizer')
    plugins.push(visualizer({
      filename: 'dist/bundle-report.html',
      gzipSize: true,
      brotliSize: true,
      open: false,
    }))
  }

  return {
  plugins,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    watch: {
      // desktop-tauri Rust 构建产物会被锁（EBUSY 导致 dev server 崩溃）；
      // runtime/ 由网关随时写入 pid/日志，同样会触发 EBUSY
      ignored: ['**/desktop-tauri/**', '**/native-live2d/target/**', '**/src-tauri/**', '**/runtime/**']
    },
    proxy: {
      '/api':         { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/sdapi':       { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/controlnet':  { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/adetailer':   { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/scene-showcase': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/character-references': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/docs':        { target: 'http://127.0.0.1:3000', changeOrigin: true },
      // dev 模式下 tools/ 由 Express 提供，Vite 需转发
      // （/assets/ 见上方 express-assets-conditional-proxy 插件）
      '/tools':       { target: 'http://127.0.0.1:3000', changeOrigin: true }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    manifest: true,
    // 避免与 Express 已有的 /assets/ 路由（角色图等）冲突
    assetsDir: '_app',
    // 固定构建目标，别随 Vite 默认值漂移；与 package.json 的 browserslist 对齐
    target: ['chrome111', 'edge111', 'firefox113', 'safari16.4'],
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // 框架单独成块：应用代码改动不该让 Vue/Router/Pinia 的缓存一起失效
          if (id.includes('node_modules/vue/') ||
              id.includes('node_modules/@vue/') ||
              id.includes('node_modules/vue-router/') ||
              id.includes('node_modules/pinia/')) {
            return 'vendor'
          }
          if (id.includes('node_modules/motion/') || id.includes('node_modules/framer-motion/')) {
            return 'motion'
          }
          // 共享基础模块单独成块：client/storageKeys/characters 等被入口链与
          // 多个异步块共同引用，不固定时会被 rollup 吸进 live2d 手工块；
          // vite/preload-helper 是所有动态导入 chunk 的公共助手，同样必须
          // 固定——否则入口和所有路由闭包会静态背上整个 live2d 依赖（73KB）。
          if (id.includes('node_modules/@vueuse/') ||
              id.includes('src/api/client') ||
              id.includes('src/api/mediaStatusApi') ||
              // Shared by the entry and Live2D: never pull the heavy chunk into first paint.
              id.includes('src/utils/motionPreference') ||
              id.includes('src/utils/storageKeys') ||
              id.includes('src/utils/localDiagnostics') ||
              id.includes('src/utils/sdStatus') ||
              id.includes('src/config/characters') ||
              id.includes('companionAffection') ||
              id.includes('useCompanionAffection') ||
              id.includes('vite/preload-helper')) {
            return 'shared'
          }
          // 提示词策略与热门内容单独成块：改一个词条不应让全量 vendor 缓存失效
          if (id.includes('src/utils/promptPolicy') ||
              id.includes('src/utils/promptCompiler') ||
              id.includes('src/utils/popularContent') ||
              id.includes('src/config/artistStyleCatalog') ||
              id.includes('src/config/artistStyles')) {
            return 'prompt'
          }
          if (id.includes('src/composables/live2d/') ||
              id.includes('src/utils/emotionRuntime') ||
              id.includes('src/utils/blinkScheduler')) {
            return 'live2d'
          }
          return undefined
        }
      }
    }
  }
  }
})
