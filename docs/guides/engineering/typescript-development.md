# TypeScript 开发与维护

说明源码编辑、构建产物、日常检查与桌面打包工具链的分工。工程边界见 [工程契约](../../engineering-contracts.md)，命令总表见 [工作流](../../workflow.md)。

---

## 1. 源码与生成产物边界

- **编辑源码，禁改产物**：Node 维护脚本与独立静态页脚本源码为 `.ts`/`.mts`/`.cts`；生成的 `.js`/`.mjs`/`.cjs` 为运行产物，仅通过 `npm run build:runtime` 更新，严禁手改（第三方 `vendor` 除外）。
- **Rust 网关独立构建**：前端由 Vite 构建，产品网关在 `runtime-rs/` 构建，不携带 Node sidecar。

| 范围 | 类型检查配置 | 构建命令与输出 |
| --- | --- | --- |
| Vue 前端 | `tsconfig.app.json` | `npm run build` → `dist/` |
| Node 维护脚本 | `tsconfig.node.json` | `npm run build:runtime` → 原位置 `.js`/`.mjs`/`.cjs` |
| 独立静态页脚本 | `tsconfig.browser-tools.json` | `npm run build:runtime` → 原位置浏览器 `.js` |

---

## 2. 日常开发与类型检查

```powershell
# 日常开发联调（前端热更新 + Rust 网关热重启）
npm run dev
npm run dev:server   # 监视 runtime-rs 变更，排空旧网关后重启新副本（scripts/dev-server.mts）

# 分域类型检查（仅检查，不改写产物）
npm run typecheck:app
npm run typecheck:node
npm run typecheck:browser-tools
npm run wf -- check:typescript

# 强制重建 Node/浏览器工具产物（缓存位于 .cache/typescript-build/）
npm run build:runtime -- --force
```

> 删除 `.ts` 源码后，构建器仅安全清理上次构建记录中未修改的对应输出文件，不会误删手工文件。

---

## 3. 类型归属与工具链约束

- **类型归属**：前端复用 `src/types/`，跨端 DTO 放根目录 `types/`；后端不得反向引用 `src/`。接口与文件边界必须在运行时做数据校验，类型声明不替代校验。
- **异常处理**：不要假设捕获异常一定是 `Error` 实例，通用错误读取集中于 `scripts/lib/runtime-errors.ts`。
- **ESLint 入口**：仅编辑 `eslint.config.mts`（`eslint.config.js` 转发至该源码）；模块边界由 `scripts/lib/module-boundaries.mts` 约束，单文件建议 ≤ 500 有效行。
- **Node 版本**：开发机推荐 `.nvmrc`（`24.18.0`），源码维护工具最低兼容 `package.json` 声明的 **Node ≥ 22.18**（以锁文件为准，不可仅凭 `@types/node` 使用更高版本 API）；成品桌面端无需用户安装 Node。
- **外部参考**：[TypeScript CJS/ESM 互操作](https://www.typescriptlang.org/docs/handbook/modules/reference.html#node16-node18-node20-nodenext) · [Node.js 22 TS 支持](https://nodejs.org/docs/latest-v22.x/api/typescript.html)。
