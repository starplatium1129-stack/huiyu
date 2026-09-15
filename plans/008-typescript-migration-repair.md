# 008 — TypeScript 迁移修复（进行中，阻塞级）

- **Status**: IN_PROGRESS（WIP 检查点已落，待模型配额恢复后按批次续做）
- **Branch**: `codex/ts-migration-repair-20260915`
- **Commit**: `b0ceaf8`（WIP，未合并、未推 main）
- **Severity**: BLOCKER — 构建、测试、桌面打包、CI 全链路不可用
- **Category**: Build / TypeScript 迁移
- **Estimated scope**: 剩余约 11,310 个类型错误，跨 ~150 个 `.ts` 文件，需逐点现场修复

## Problem

提交 `63889f4 migrate project sources to TypeScript`（连同基础提交 `ba50cef`）**已推送到 origin/main 且本地与远端完全同步**，但它把仓库带入了**构建中断**状态：

- `scripts/build-node.mts` 是所有运行态 JS 的唯一生成器，且硬要求每个 tsconfig `strict: true`；
- 只要任一诊断存在即 `throw`，**且在抛错前不写入任何产物**；
- 因此 `npm ci`(postinstall) / `npm run build`(prebuild) / `npm start`(prestart) / CI `quality.yml` **全部会失败**。

当前 app 之所以还能跑，纯粹因为仓库里仍留有**迁移前的旧 JS 兜底**——而迁移后的 `.ts` 与运行中的 `.js` **已经分叉**（抽查 6 个文件仅 2 个字节完全一致；近 6 小时 449 个 `.ts` 变动对 26 个 `.js`）。也就是说**改 TS 目前完全不影响运行时**。

## 根因（已彻查，非猜测）

`63889f4` 是**自动化类型推断迁移**的产物（证据：`.cache/typescript-migration/` 下有 `inferred-types.json`、`inference-progress.log`、1MB 的 `initial-types.log`）。它做了三件事：

1. ✅ `var x = require('...')` → `let x: typeof import('...') = require('...')` —— **正确，保留**
2. ✅ `var` → `let` —— **保留**
3. ❌ **凭空给本来没有任何标注的 JS 注入 `{}` / `unknown` / 过窄的结构类型** —— 罪魁

第 3 类的实际形态：

```ts
// 过窄且把可选参数写成必填
function registerServiceRoutes(router, ctx: { ops: { rejectConflict: (arg0: unknown) => unknown; ... } })
// 局部变量被注成 {}，后续属性访问全报 TS2339
let part = parts[i] || {};  part.type        // Property 'type' does not exist on type '{}'
// 工厂签名用 unknown 值域
function createChatRouter(config: { OLLAMA_HOST: unknown; ... }, dependencies: { ollama?: unknown; })
```

**关键认知：原始 JS 里这些变量本来根本没有标注，很多错误是「无中生有的标注」造成的。** 因此正确修法常常是**删掉凭空注入的标注、让 TS 自行推断**，而不是再写一个更复杂但仍然错误的类型。

上游代理自己的记录 `.cache/typescript-migration/diagnostic-counts.json` 写着 `total: 5395` —— **明知是红的仍然提交了**。

## 基线损伤全景

`node` / `tests` / `services` 三个项目是单 program 全量检查，普通 `tsc -p <config> --noEmit` 与官方等价。

| 项目 | 配置 | 官方结果 | 基线错误数 |
| --- | --- | --- | --- |
| Vue 前端 | `tsconfig.app.json` | PASS | 0 |
| services | `tsconfig.runtime.json` | PASS | 0 |
| browser-tools | `tsconfig.browser-tools.json` | **PASS** | 0 |
| 网关/路由/脚本 | `tsconfig.node.json` | FAIL | **5,395** |
| 测试 | `tsconfig.tests.json` | FAIL | **10,485** |
| | | | **合计 15,880** |

注意：`server/` 目录**本身就是干净的（0 错）**；红色只在 `server.ts`(12) + `routes/`(1,674)。

错误码主因：TS7006 隐式 any 1,527、TS2339 属性不存在 1,279、TS18046 unknown 627、TS2345 569、TS2554 347。

错误高度集中在工具脚本：`scripts/maintenance` 2,290 + `scripts/lib` 1,763（占 node 项目 75%），发货路径 `routes`+`server.ts` 仅约 24%。

## 修复标准（四类场景，后续批次统一遵循）

codemod 新增的 `require` 类型标注与 `var→let` **保留**；只修第 3 类损伤。

1. **路由工厂签名**：`config: {X: unknown}` → `config: GatewayConfig`（复用 `server/config-types.ts`，它派生自 `ReturnType<typeof loadGatewayConfig>`）。
   `dependencies` → 该工厂**自己的精确类型**，且**必须可选**（`dependencies?: XxxDependencies`）。理由：`server/gateway-types.ts` 的 `ServiceDependencies` 是**从各工厂第 2 形参反推**的（`NonNullable<Parameters<...>[1]>`），所以工厂不能反向引用它（会循环），且 `server.ts` 会传可能为 `undefined` 的 `options.services`。
2. **外部 / 不可信载荷**（模型 API 响应、SSE 事件流、磁盘 JSON、HTTP 请求体、子进程输出）：用宽松类型（`any` / `Record<string, any>`），并**原样保留已有的 `typeof` / `Array.isArray` / `?.` 运行时守卫**。依据 `docs/guides/engineering/typescript-development.md`：「文件内容与外部返回值仍需要运行时校验，类型声明不代替数据验证」。
3. **Express 处理器**：`router: express.Router`、`req: express.Request`、`res: express.Response`。
4. **局部变量**：优先删掉凭空注入的 `{}` 标注让 TS 推断；推断确实不可行时才显式标注。

**绝对禁止**：`@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`；为过关而删除或弱化断言、改运行时逻辑、改导出契约；无差别的 `as any`；只改 `.js`（构建产物，改了无效）。

参考范式（已落地于 `routes/chat.ts`）：

```ts
import type { GatewayConfig } from '../server/config-types';

/** 注入的 Ollama 客户端；缺省时工厂按 config 自行创建。 */
type ChatDependencies = { ollama?: ReturnType<typeof createOllamaService> };

function createChatRouter(config: GatewayConfig, dependencies?: ChatDependencies) {
```

注意：签名类修复对整个 node 项目只削掉约 10 个错误，**真正的量在局部变量的 `{}` 标注上**，不要以为改完签名就完事。

## 剩余批次（按执行顺序）

进度基线：WIP 检查点测得 node 3,087 / tests 8,223（已完成约 29%）。

| 批次 | 范围 | 检查点残留 | 备注 |
| --- | --- | --- | --- |
| B1 | `routes/video/**` | 306 | **完全未开始** |
| B2 | `routes/control/**` | 82 | **完全未开始** |
| B3 | `server.ts` | 10 | 主要是路由工厂签名的下游症状；`server.ts:379` 的 `control.close()` 需查清 `createControlRouter` 的真实返回结构（含 `close`），不要靠断言掩盖 |
| B4 | `routes/` 顶层残留 | 793 | 重灾区：`generation.ts` 197、`video.ts` 100、`video-ai.ts` 93、`chat.ts` 84、`maintenance.ts` 61 |
| B5 | `scripts/lib/**` | 1,450 | 第一梯队：`resource-install-fs.ts` 97、`resource-install-gateway.ts` 89、`content-impact-format.ts` 78、`delivery-report-format.ts` 73、`generation-candidates.ts` 59 |
| B6 | `scripts/maintenance/**` | 402 | 收尾 |
| B7 | `scripts/tests/**`（tests 项目） | 8,223 | 依赖 B4–B6 稳定后再开，否则返工 |
| B8 | `browser` 项目 | 0 | 已 PASS，无需处理 |

## 门禁与验收命令

```bash
cd /d/code/ai-cg-studio-main

npx tsc -p tsconfig.node.json  --noEmit > /tmp/n.log 2>&1
npx tsc -p tsconfig.tests.json --noEmit > /tmp/t.log 2>&1
sed -e 's/\x1b\[[0-9;]*m//g' /tmp/n.log > /tmp/n.plain.log   # 必须去 ANSI
sed -e 's/\x1b\[[0-9;]*m//g' /tmp/t.log > /tmp/t.plain.log

grep -cE 'error TS[0-9]+' /tmp/n.plain.log                   # 目标 0
grep -cE 'error TS[0-9]+' /tmp/t.plain.log                   # 目标 0

# 官方验证（等价于 CI 的构建路径）
node scripts/build-node.mts --check
node scripts/build-node.mts --project browser --check        # browser 必须单独隔离检查
```

## ⚠️ 已确认的坑（勿重蹈）

1. **ANSI 颜色码会骗过 grep**：TS 诊断带颜色码，把 `error` 与 `TS2339` 隔开，对**未去色**日志 `grep -c 'error TS'` 返回 **0**，看起来像「已归零」。**先去色再统计。**
2. **`browser` 项目逐文件隔离检查**（`build-node.mts` 里 `project === 'browser'` 时每个文件一个 program）。用普通 `tsc -p tsconfig.browser-tools.json` 合并检查会因跨文件同名函数（`escapeHtml`/`init`）误报 TS2393。**该项目实际 PASS，不要被误报带偏。**
3. **工作器自报数字不可信**：本轮已抓到一次实例——某工作器报告「`scripts/lib` 1763 → 0」，实测仍有 1,591 错。**任何完成声明一律以我方去色统计为准。**
4. **产物写入发生在所有项目通过之后**（`for (const item of pending)` 在 `throw` 之后）：node 项目里只要 `scripts/` 仍红，`server`/`routes` 的 JS **也不会被重新生成**。
5. **不能靠拆分构建项目来隔离脚本债务**：TS 会连带检查被 `import` 的文件，而 `routes/chat.ts` 正 import 了 `scripts/lib/runtime-errors`，所以拆出 `scripts/` 并不能让网关先绿。已评估并放弃。
6. `.cache/typescript-build/` 当前**不存在**（无热缓存）——所以本地热缓存从未掩盖过这个红状态，任何一次 `npm ci` 都会失败。

## 修绿之后的后续链路

1. **干净状态验证**：清空 `.cache/typescript-build/` 与所有生成物后跑 `node scripts/build-node.mts`，确认四个项目全绿且产物可重建（模拟 fresh clone）。
2. **取消跟踪生成 JS**：`git rm --cached` 处理那 **449 个已被 `.gitignore` 覆盖却仍被跟踪**的 JS（`.gitignore` 第 32–49 行已声明「TypeScript is the source of truth」）。保留 4 个合理例外：`poc/live2d-compare/vendor/{cubism2,cubism4,index}.js`（第三方 vendor）与 `poc/audit-stability-apply.cjs`。
   **前置条件：必须先修绿**——此刻取消跟踪会让新克隆既无可用 JS 又编译不出来，仓库直接不可运行。
3. **推广生成物守卫**：把 `scripts/maintenance/runtime-generated-files.ts` + `scripts/tests/test-runtime-generated.ts` 的「产物不得被 Git 跟踪」断言从 `services/` 推广到 `server` / `routes` / `scripts`。
4. **完整测试**：`npm run check`、`npm run validate`（含 `test:frontend` / `test:unit` / `test:contract`）。
5. **桌面打包与实机验收**：只用 `deploy-desktop.bat`（UAC 由用户操作）；`npm run package:tauri` 产出 NSIS 安装包；随后实机运行验收。未执行或失败的步骤如实列出，历史 PASS 不替代当次证据。

## 决策记录

- 用户已拍板：**修复迁移**（保留 TS 为唯一真源）／**修绿后再取消跟踪**生成 JS／**一路推到桌面验收**。解锁顺序选「按推荐方案」，最终目标是全部迁移完成。
- 已排除的替代路线：回滚迁移提交、分层收割、拆分构建项目（理由见坑 5）。

## 未决 / 阻塞

- **模型配额 429**：并行工作器全部中断，配额 **2026-09-16 02:37 UTC+8** 重置。
- **`git push` 挂起**：WIP 分支推送长时间无输出，疑与代理（127.0.0.1:7897）连通性有关；提交本身已安全落在本地分支。按既有经验**先查代理，再怀疑授权**。
- **行为验证缺口**：`build:runtime` 仍不可能通过，因此当前所有改动**只有类型层面证据，没有任何运行时验证**。控制流守恒（`if/return/throw/assert` 删除 144 行 / 新增 145 行）与「无新增 `@ts-*` 抑制」已抽检通过，但不等于行为不变。
