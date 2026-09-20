import { moduleBoundaries } from './scripts/lib/module-boundaries.mts'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'

// ── 运行时全局白名单（2026-08-22 环境分离）────────────────────────────────
// 设计原则：共享运行时（Node 22+ 与现代浏览器都内置的 Web API）放基础层；
// 仅单侧存在的 API 进各自作用域块。这样后端误用 DOM、前端误用 process
// 由 tsc 的环境 lib/types 与下面的 no-restricted-globals 分别把关；生成 JS 不 lint。

// 两边都有的：控制台 / 定时器 / 取消 / URL·Blob·fetch / 编码与类型数组 / 加密 / 性能
const SHARED_RUNTIME_GLOBALS = {
  console: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  Blob: 'readonly',
  fetch: 'readonly',
  crypto: 'readonly',
  performance: 'readonly',
  structuredClone: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  DataView: 'readonly',
  Uint8Array: 'readonly',
  Uint8ClampedArray: 'readonly',
  ArrayBuffer: 'readonly',
  Intl: 'readonly',
  globalThis: 'readonly',
  Event: 'readonly',
  EventTarget: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  DOMException: 'readonly',
} as const

// 仅浏览器：DOM / 存储 / 媒体 / 输入交互
const BROWSER_ONLY_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  location: 'readonly',
  history: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  navigator: 'readonly',
  FileReader: 'readonly',
  Image: 'readonly',
  HTMLImageElement: 'readonly',
  HTMLInputElement: 'readonly',
  HTMLElement: 'readonly',
  HTMLDialogElement: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
  alert: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  SpeechSynthesis: 'readonly',
  SpeechSynthesisUtterance: 'readonly',
  speechSynthesis: 'readonly',
  indexedDB: 'readonly',
  IDBDatabase: 'readonly',
  IDBTransaction: 'readonly',
  IDBRequest: 'readonly',
  createImageBitmap: 'readonly',
  getComputedStyle: 'readonly',
  CustomEvent: 'readonly',
  PointerEvent: 'readonly',
  KeyboardEvent: 'readonly',
  ResizeObserver: 'readonly',
  IntersectionObserver: 'readonly',
  MutationObserver: 'readonly',
} as const

// 仅 Node：进程 / 模块系统 / 二进制
const NODE_ONLY_GLOBALS = {
  process: 'readonly',
  require: 'readonly',
  module: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
} as const

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'node_modules/**', 'assets/vendor/**', 'docs/**', 'test-results/**',
      // services/*.d.ts 是 build:runtime 生成产物，不参与 lint
      'services/*.d.ts', 'services/*.js',
      'server.js', 'server/**/*.js', 'routes/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs',
      'tools/**/*.js', 'assets/theme-bootstrap.js', 'eslint.config.mjs',
      'scripts/archive/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
      },
      // 基础层只放共享运行时；浏览器/Node 专属 API 走下方作用域块，
      // 源码环境由 tsc 和 no-restricted-globals 校验。
      globals: { ...SHARED_RUNTIME_GLOBALS },
    },
    rules: {
      // 个人项目门禁：未使用变量、显式 any 回退、console 残留、v-html XSS
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        // TS 类型导入（import type / type 修饰符）不应报未使用
        caughtErrors: 'none',
      }],
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'vue/no-v-html': 'warn',
      // TS 文件的未定义标识符交给 vue-tsc/tsc 把关，这里关闭避免与类型系统打架；
      // 生成 JS 不重复检查；关键环境误用另由显式全局限制检查。
      'no-undef': 'off',
      // 模板纯风格规则关闭：项目有自己的一致性，不按 eslint 默认模板风格排版
      'vue/multi-word-component-names': 'off',
      'vue/attributes-order': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/html-self-closing': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-indent': 'off',
      'vue/html-quotes': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/component-definition-name-casing': 'off',
      'vue/require-default-prop': 'off',
      // 正确性规则（2026-08-22 恢复）：v-for 无 key 会导致列表复用错乱；
      // 子组件变更 props 会破坏单向数据流。其余纯风格规则继续豁免。
      'vue/require-v-for-key': 'error',
      'vue/no-mutating-props': 'error',
      'vue/no-v-model-argument': 'off',
      'vue/v-on-event-hyphenation': 'off',
      'vue/attribute-hyphenation': 'off',
      'vue/html-button-has-type': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-closing-bracket-spacing': 'off',
      'vue/valid-v-model': 'off',
      'vue/no-unused-refs': 'off',
      'vue/valid-template-root': 'off',
      'vue/no-template-shadow': 'off',
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-constant-condition': 'off',
      'no-control-regex': 'off',
      'no-prototype-builtins': 'off',
      'no-case-declarations': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // 历史 services 代码的既有模式（this 别名、namespace、Function 类型），
      // 重构时随文件一起治理，不在本次门禁里硬卡
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'no-useless-assignment': 'off',
      'no-unassigned-vars': 'off',
      'prefer-const': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    // 浏览器域：前端源码与组件
    files: ['src/**/*', 'tools/**/*.ts'],
    languageOptions: {
      globals: { ...SHARED_RUNTIME_GLOBALS, ...BROWSER_ONLY_GLOBALS },
    },
  },
  {
    // Node 域：网关、路由、服务层与维护脚本
    files: ['server.ts', 'server/**', 'routes/**', 'services/**', 'scripts/**'],
    languageOptions: {
      globals: { ...SHARED_RUNTIME_GLOBALS, ...NODE_ONLY_GLOBALS },
    },
  },
  {
    // CDP 调试脚本在 page.evaluate 回调里编写浏览器侧代码：
    // 对这些文件补回浏览器全局，避免 no-undef 误报。
    files: ['scripts/maintenance/cdp-*.ts'],
    languageOptions: {
      globals: { ...SHARED_RUNTIME_GLOBALS, ...NODE_ONLY_GLOBALS, ...BROWSER_ONLY_GLOBALS },
    },
  },
  {
    files: ['**/*.vue'],
    rules: {
      'vue/component-definition-name-casing': 'off',
      // .vue 模板消费的脚本导入 ESLint 不可见，未使用判断交给 vue-tsc
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    // 维护/测试脚本：console 是 CLI 输出方式，不按应用代码的 no-console 管
    files: ['scripts/**', 'routes/**'],
    rules: {
      'no-console': 'off',
    },
  },
  // 体量硬门禁唯一入口：test-monolith-budget.ts（600 有效行），不保留 1000 行旧预警。
  {
    files: ['src/**/*.{ts,vue}', 'tools/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', 'process', 'require', '__dirname', 'Buffer'] },
  },
  {
    files: ['server.ts', 'server/**/*.ts', 'routes/**/*.ts', 'services/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', 'window', 'document', 'localStorage', 'navigator'] },
  },
  {
    files: ['src/types/**/*.ts', 'src/utils/historyRecipe.ts', 'src/utils/generationTask.ts', 'src/utils/promptPolicy.ts'],
    rules: { 'no-restricted-globals': ['error', 'process', 'require', '__dirname', 'Buffer', 'window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator'] },
  },
  {
    files: ['src/**/*.{ts,vue}', 'server/generation/**/*.ts'],
    plugins: { huiyu: { rules: { 'module-boundaries': moduleBoundaries } } },
    rules: { 'huiyu/module-boundaries': 'error' },
  },
  {
    files: ['server/generation/**/*.ts', 'routes/generation.ts', 'src/stores/promptBuilderStore.ts',
      'src/utils/promptCatalog.ts', 'src/composables/prompt/usePromptDraft.ts',
      'src/composables/prompt/usePromptArtworkHistory.ts', 'src/composables/prompt/usePromptSceneFilters.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'error' },
  },
)
