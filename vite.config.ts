import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { compile, Polyfills, toSourceMap } from '@tailwindcss/node'
import { dirname, resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'

const runtimeRequire = createRequire(import.meta.url)

/** All supported browsers implement color-mix (Chrome 111 / Safari 16.4 /
 * Firefox 128). Tailwind's Vite plugin currently cannot configure its polyfills:
 * https://github.com/tailwindlabs/tailwindcss/discussions/20037
 * Compile component @apply through the same official compiler with only the
 * @property fallback, avoiding duplicated color rules in every route. Keep the
 * official plugin for utility discovery/HMR. Remove this hook when its public
 * polyfill option is available; never drop these browser target requirements.
 */
function componentTailwindPlugin(): Plugin {
  const sourceRoot = fileURLToPath(new URL('./src/', import.meta.url))
  const entry = fileURLToPath(new URL('./src/assets/css/tailwind.css', import.meta.url))
  return {
    name: 'studio-tailwind-component-styles',
    enforce: 'pre',
    async transform(source, id) {
      const file = resolve(id.split('?')[0])
      if (!file.startsWith(sourceRoot) || file === entry ||
          !(/\.css(?:\?|$)|[?&]type=style/.test(id)) ||
          !/@(?:apply|reference|import)\b/.test(source)) return
      const compiler = await compile(source, {
        base: dirname(file), from: file, polyfills: Polyfills.AtProperty,
        onDependency: dependency => this.addWatchFile(dependency),
      })
      const code = compiler.build([])
      return { code, map: toSourceMap(compiler.buildSourceMap()).raw }
    },
  }
}

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

// Rust gateway 默认运行在 3000 端口；Vite dev server 在 5173
// 生产时 Rust gateway 直接 serve dist/
export default defineConfig(async ({ mode }) => {
  const plugins = [
    componentTailwindPlugin(),
    tailwindcss(),
    vue(),
    dataVersionPlugin(),
  ]
  if (mode === 'desktop') plugins.push({
    name: 'desktop-startup-assets',
    generateBundle() {
      const fs = runtimeRequire('node:fs') as typeof import('node:fs')
      for (const name of ['favicon.svg', 'logo.svg', 'logo-light.svg', 'theme-bootstrap.js']) {
        this.emitFile({ type: 'asset', fileName: `assets/${name}`, source: fs.readFileSync(fileURLToPath(new URL(`./assets/${name}`, import.meta.url))) })
      }
    },
  })
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
  base: mode === 'desktop' ? './' : '/',
  plugins,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173,
    watch: {
      // Rust 构建产物会被锁（EBUSY 导致 dev server 崩溃）；
      // runtime/ 由网关随时写入 pid/日志，同样会触发 EBUSY
      ignored: ['**/desktop-tauri/**', '**/runtime-rs/target/**', '**/native-live2d/target/**', '**/src-tauri/**', '**/runtime/**']
    },
    proxy: {
      // SFC 的 SVG 和 JSON 模块导入（?import）须由 Vite 转换成 JS；
      // 其余运行时资源交给 Rust gateway，保留其访问控制和静态服务语义。
      '^/(assets|data)/': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        bypass(req: IncomingMessage) {
          if (new URL(req.url ?? '', 'http://localhost').searchParams.has('import')) return req.url
        }
      },
      '/api':         { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/sdapi':       { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/controlnet':  { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/adetailer':   { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/scene-showcase': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/character-references': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/docs':        { target: 'http://127.0.0.1:3000', changeOrigin: true },
      // dev 模式下 tools/ 由 Rust gateway 提供，Vite 需转发
      '/tools':       { target: 'http://127.0.0.1:3000', changeOrigin: true }
    }
  },
  build: {
    outDir: mode === 'desktop' ? 'desktop-tauri/web' : 'dist',
    emptyOutDir: true,
    manifest: true,
    // 避免与 Rust gateway 已有的 /assets/ 路由（角色图等）冲突
    assetsDir: '_app',
    // 固定构建目标，别随 Vite 默认值漂移；与 package.json 的 browserslist 对齐
    target: ['chrome111', 'edge111', 'firefox128', 'safari16.4'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Split feature groups by their actual consumers, retaining lazy
          // boundaries when shared helpers also appear in another route.
          groups: [{ entriesAware: true, name(id: string) {
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
          // Shared helpers belong outside the Live2D group. entriesAware also
          // separates consumers within each group to retain lazy boundaries.
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
          // Prompt rendering, draft persistence and shared variation helpers are cached
          // by their actual consumers; full static closures remain budgeted.
          if (id.includes('src/composables/prompt/usePromptDraft') ||
              id.includes('src/composables/prompt/usePromptHistoryReuse') ||
              id.includes('src/utils/promptBuilderPersistence') ||
              id.includes('src/utils/randomVariation') ||
              id.includes('src/utils/promptPolicy') ||
              id.includes('src/utils/promptCompiler') ||
              id.includes('src/utils/studioDualSubject') ||
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
        } }],
        },
      }
    }
  }
  }
})
