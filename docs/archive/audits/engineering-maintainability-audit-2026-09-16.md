# 工程维护视角全面审计与系统提升报告（2026-09-16）

> 维护日期：2026-09-16。当前版本 1.7.1。
> 本报告从**工程可维护性（Maintainability）**、**技术债（Technical Debt）**、**构建与门禁效能（Build & Quality Gates）**及**全栈架构演进**等视角，对当前系统进行全面审计。报告保留确证数据与代码定位，提出分级具体的工程提升路线。

---

## 一、审计基准与现状评价

### 1.1 审计环境与基准
- **版本基线**：1.7.1，代码基准与当前工作树一致。
- **运行环境**：Node 24.18.0（符合 `engines: >=22.18` 要求），npm 11.16.0，Windows x64。
- **执行原则**：遵循 [AGENTS.md](../../../AGENTS.md) 保护既有工作区改动；不修改角色与场景数据，不升级未经授权的模型/真实出图任务。

### 1.2 现状总体评价
项目在工程约束层面已经建立了极其严苛的工程纪律和防线：
- **单体有效行数红线**：门禁 `test-monolith-budget.js` 约束有效行 ≤ 600 行，目前 587 个受检文件保持 **0 豁免**；
- **指令与语法防线**：`scan-ts-directives.ts` 强制禁止 `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error`；
- **样式与美术门禁**：CSS 变量完整性、GPU 动画合成器限制（仅 transform/opacity）、WCAG AA 对比度与双主题审计全覆盖；
- **数据版本与缓存一致性**：通过 13 项数据产物的 SHA-1 哈希锁定 `DATA_VERSION`，防止浏览器命中不可变缓存；
- **并发与安全防御**：Web Locks 跨标签页锁机制（`withArtworkMutation`）、CSP 分级文档跳转隔离（Live2D 动态重载）。

**结论**：项目的基础工程规范执行得非常彻底，但伴随业务体量扩展（160+ 角色、300+ 场景、1600+ 蓝图、多引擎网关与桌面原生集成），系统在**单体预算边缘堆积、服务端类型割裂、打包预算饱和、门禁重复计算、数据构建污染源码**等维度出现了显著的维护边际成本上升。

---

## 二、七大核心工程维度审计与提升建议

---

### 维度 1：单体预算机制下的「边缘堆积」与控制器职责过载

#### 现状与数据
虽然 `scripts/tests/test-monolith-budget.js` 门禁报告 587 个文件全部通过（0 豁免），但针对有效代码行数（跳过注释与空行）的扫描显示，**大量核心文件处于 580 ~ 599 行的极度压线状态**：

| 文件路径 | 有效行数 | 距离 600 行红线 | 核心职责 |
| :--- | :---: | :---: | :--- |
| `routes/anima.ts` | 599 | **1 行** | Anima 请求校验、工作流构建、Inpaint 调度、Comfy 代理 |
| `src/components/visual/SemanticParticleField.vue` | 595 | 5 行 | WebGL/Canvas 粒子场着色器与语义响应 |
| `src/composables/gallery/useGalleryWorkspace.ts` | 592 | 8 行 | 画册工作台状态、选择集、筛选、布局参数编排 |
| `src/views/ChatView.vue` | 591 | 9 行 | 角色房间主视图、模型源切换、TTS声线、舞台调度、记忆归档 |
| `src/components/ArtistStylePicker.vue` | 588 | 12 行 | 画风选择器、流式过滤、分类索引与预览 |
| `routes/video-ai.ts` | 587 | 13 行 | 视频 AI 分镜润色、台词推导、LLM 路由与错误规整 |
| `routes/video.ts` | 586 | 14 行 | 视频渲染引擎代理、H3/Wan 工作流构建、任务追踪 |
| `src/views/ShowcaseView.vue` | 580 | 20 行 | 样张陈列室全流程、多视角对比、候选管理 |
| `src/components/video/ShotListEditor.vue` | 579 | 21 行 | 视频分镜编辑器、节拍对齐、镜头参数维护 |
| `src/utils/tagMeaning.ts` | 578 | 22 行 | 提示词标签多语言词典与释义字典 |
| `src/stores/promptBuilderStore.ts` | 548 | 52 行 | 生图工作台主状态机（71 个公开字段） |
| `server.ts` | 531 | 69 行 | 网关入口、中间件装配、安全防御与静态路由映射 |

#### 根因分析
1. **行数红线的“逆向激励”**：600 行红线成功遏制了文件无限膨胀，但引发了“就地压缩”的反模式。开发者为了避免触发门禁，倾向于压缩三元表达式、合并类型定义、抽离琐碎的一次性函数，而不是做深度的领域解耦。
2. **上帝视图（God Views）未完全拆净**：以 `src/views/ChatView.vue` 为例，一个 View 组件承担了至少 6 个独立关注点：
   - 本地 Ollama 与自定义 API 供应商选择与推理档位控制；
   - 实时配音（TTS / GPT-SoVITS）声线控制台与播放状态机；
   - Live2D 舞台（`ChatCharacterStage`）的生命周期与换装响应；
   - 记忆归档、用户画像、长期记忆三个大型弹窗面板的联动；
   - 输入框快捷键捕获、中断流式回复与实时字数计数；
   - 消息流式 token 追加与多模态重播。

#### 具体提升建议
1. **视图层按子控制器拆分子组件（View Controller Decomposition）**：
   - 将 `ChatView.vue` 的模型源切换与思考强度控制抽取为 `src/components/chat/ChatModelSelector.vue`；
   - 将底部的配音控制台抽取为 `src/components/chat/ChatVoiceConsole.vue`；
   - `ChatView.vue` 有效行数可直接降至 350 行左右，给未来业务留出安全缓冲区。
2. **服务端管线分层（Pipeline & Controller Separation）**：
   - 针对 `routes/anima.ts` (599行) 与 `routes/video.ts` (586行)，剥离出独立的 `WorkflowsBuilder`（纯工作流 JSON 构建）与 `TaskCoordinator`（ComfyUI 轮询跟踪），使 Route 文件只保留 HTTP 参数提取、安全断言与响应输出。

---

### 维度 2：前后端类型系统割裂与服务端「Any 蔓延」

#### 现状与数据
- 前端 `src/` 类型纯净度极高（扫描全量代码，仅 1 处在注释中提到 any，且受 `scan-ts-directives.ts` 强制无 `@ts-ignore`）。
- **然而服务端 `routes/` 扫描出 391 处 `any`，`server/` 扫描出 70 处 `any`**。
- `eslint.config.mts` 中针对 Node 域将 `@typescript-eslint/no-explicit-any` 显式放宽为 `'warn'`，并关停了 `prefer-const: off`、`no-unassigned-vars: off`、`no-useless-assignment: off`。

典型代码形态（`routes/video.ts`、`routes/voice.ts`、`routes/generation.ts`）：
```typescript
function createVoiceRouter(config: any, dependencies: any) { ... }
function requestOwner(req: any) { ... }
function validateInput(body: any, config?: any, options?: any) { ... }
async function poll(job: any) { ... }
```

#### 根因分析
1. **历史 Express 动态惯性**：服务端大量使用 Node 经典回调与动态扩展对象，依赖手写的 `validateInput()` 做运行时防御，未建立统一的 TypeScript 接口层。
2. **前后端缺少共用契约（Single Source of Truth）**：
   - 前端在 `src/api/*.ts` 中定义了前端理解的入参与出参（如 `GenerationTaskRequest`、`VideoJob`）；
   - 后端在 `routes/*.ts` 中用 `any` 接收请求、构造响应；
   - **两端没有类型绑定**：若后端接口重命名字段或新增必填项，编译期（`vue-tsc` 与 `tsc`）完全无法发现契约断裂，只能依赖后续运行时的契约测试。

#### 具体提升建议
1. **建立共享契约层（Shared Contract Definitions）**：
   - 在 `types/contracts/` 或 `src/types/api/` 中建立共享的 Request/Response 强类型定义，前后端共用，消除重复声明。
2. **强类型路由包装器（Typed Route Handlers）**：
   - 编写薄封装辅助函数：
     ```typescript
     export function typedHandler<TBody = unknown, TQuery = unknown, TParams = unknown>(
       schema: { body?: (b: unknown) => TBody },
       fn: (context: { body: TBody; query: TQuery; params: TParams; req: Request; res: Response }) => Promise<void>
     ): RequestHandler { ... }
     ```
   - 消除 `(req: any, res: any)`，将 `@typescript-eslint/no-explicit-any` 在 `routes/` 逐步升级为 `'error'`。

---

### 维度 3：打包体积与预算饱和度风险（Entry CSS 临界危机）

#### 现状与数据
`scripts/maintenance/check-bundle-budget.js` 设定的各打包预算已极度逼近天花板：

| 预算指标 | 预算上限 | 实际体积 | 饱和度 | 状态 |
| :--- | :---: | :---: | :---: | :---: |
| **入口样式 (`entryCss`)** | 100 KiB | **99.1 KiB** | **99.1%** | 🔴 极危（仅差 0.9 KiB） |
| **工作台路由样式 (`routeCss`)** | 115 KiB | 103.6 KiB | 90.1% | 🟡 预警 |
| **Live2D 懒加载块 (`lazyChunk`)** | 1000 KiB | 923.4 KiB | 92.3% | 🟡 预警 |
| **最大路由静态闭包 (`routeClosureJavaScript`)** | 580 KiB | 533.1 KiB | 91.9% | 🟡 预警 |
| 路由入口 JS (`routeJavaScript`) | 140 KiB | ~126 KiB | 90.0% | 🟢 正常 |
| 全局入口闭包 (`entryClosureJavaScript`) | 390 KiB | 342.6 KiB | 87.8% | 🟢 正常 |

#### 根因分析：`tokens.css` 的静态角色选择器堆积
深入剖析入口 CSS 为何达到 99.1 KiB：
- 打开 `src/assets/css/director/tokens.css`（总长 1,150 行）。
- **从第 58 行至 1124 行，全部是为 160+ 位角色静态硬编码的主题规则**：
  ```css
  .pb[data-character="alisa_mikhailovna_kujou"] { ... }
  body:has(.pb[data-character="alisa_mikhailovna_kujou"]) { ... }
  .pb[data-character="artoria_pendragon"] { ... }
  body:has(.pb[data-character="artoria_pendragon"]) { ... }
  /* ... 重复持续 1,000+ 行 ... */
  ```
- 按照当前项目规范，每接入一位新角色，都必须在 `tokens.css` 静态追加十数行选择器。**这导致入口 CSS 随着角色数量呈无上限线性增长**，直接逼死 100 KiB 门禁。

#### 具体提升建议
1. **动态主题变量注入（Dynamic CSS Custom Properties）**：
   - 角色档案 `data/characters.json` 中已经收录了每位角色的主色 `accent_color`（十六进制）。
   - 废弃 `tokens.css` 中 800+ 行静态角色选择器，改由生图台或全局容器根据当前选中的角色，在根节点动态绑定 CSS 变量：
     ```html
     <div class="pb" :style="{ '--character-accent': activeChar.accentColor }">
     ```
   - 相关的 `--character-soft`、`--character-glow`、`--character-aura` 直接在 CSS 中通过标准 `color-mix()` 派生：
     ```css
     :root {
       --character-soft: color-mix(in srgb, var(--character-accent, #6366f1) 20%, transparent);
       --character-glow: color-mix(in srgb, var(--character-accent, #6366f1) 12%, transparent);
       --character-aura: color-mix(in srgb, var(--character-accent, #6366f1) 6%, transparent);
     }
     ```
   - **工程收益**：**立即为入口 CSS 砍掉 15 ~ 20 KiB 体积**，将 entryCss 从 99.1 KiB 降至 80 KiB 左右，彻底解除预算爆雷危机，且后续接入新角色无需再改写 CSS。
2. **Rollup 分包细化**：
   - 修复 `vite.config.ts` 中 `@vueuse` 被硬编码分入 `motion` 命名块的问题，实现更符合语义的依赖拆分。

---

### 维度 4：数据治理与构建机制：解耦 `DATA_VERSION` 与源码修改

#### 现状机制与痛点
- 客户端请求 13 个静态数据 JSON 时带 `?v=DATA_VERSION`，服务端使用一年不可变（immutable）缓存。
- `scripts/lib/data-version.js` 的 `syncDataVersion` 采用正则匹配，**直接以脚本写入 `src/stores/sceneStore.ts` 源码**：
  ```javascript
  const next = src.replace(/DATA_VERSION\s*=\s*\d+/, `DATA_VERSION = ${version}`);
  fs.writeFileSync(storeFile, next, 'utf8');
  ```
- **核心工程痛点**：
  - **工作区频繁“被污染”（Dirty Worktree）**：任何维护脚本（如 `data:build`、`scenes:normalize`、`popular:build`）只要运行，就会就地改写 `src/stores/sceneStore.ts`。
  - **版本控制与协作冲突**：多个开发者、双机同步或 AI 会话协作时，数据编译产生的 `sceneStore.ts` diff 极易引发 Git 冲突或阻断受控提交。

#### 具体提升建议
- **方案 A（Vite 虚拟模块，强烈推荐）**：
  在 `vite.config.ts` 中注册微型虚拟模块插件：
  ```typescript
  {
    name: 'virtual-data-version',
    resolveId(id) { if (id === 'virtual:data-version') return '\0virtual:data-version'; },
    load(id) {
      if (id === '\0virtual:data-version') {
        const version = expectedDataVersion(process.cwd());
        return `export const DATA_VERSION = ${version};`;
      }
    }
  }
  ```
  `src/stores/sceneStore.ts` 仅需 `import { DATA_VERSION } from 'virtual:data-version'`。
  **收益**：源码永远保持干净，构建与开发时自动注入最新哈希，零 git diff。
- **方案 B（生成独立文件）**：
  将版本号生成至 `.gitignore` 忽略的文件（如 `src/generated/data-version.gen.ts`），杜绝直接修改手写的 store 源码。

---

### 维度 5：质量门禁与 CI/CD 效能：消除「重复执行」与串行瓶颈

#### 现状数据与冗余发现
1. **本地门禁 `npm run check` 的重复执行问题**：
   - `scripts/maintenance/run-check-parallel.js` 启动 6 并发运行 22 个步骤。
   - 步骤 1 为 `['test:check', 'npm run test:check']`，它内部调用了 `run-quality-suite.js check`，**该套件中已经完整执行了**：
     - `test-monolith-budget.js`
     - `test-icon-button-labels.js`
     - `test-ux-regressions.js`
     - `test-style-debt.js`
   - **但 `run-check-parallel.js` 在后续步骤中，又再次单独启动了**：
     - `['a11y-labels', 'node scripts/tests/test-icon-button-labels.js']`
     - `['ux-regressions', 'node scripts/tests/test-ux-regressions.js']`
     - `['monolith-budget', 'node scripts/tests/test-monolith-budget.js']`
     - `['style-literals', '...']`、`['contrast', '...']`、`['colors', '...']`、`['animations', '...']`
   - **结论**：在一次完整的 `npm run check` 中，上述单体预算、无障碍标签、UX 回归与样式债等耗时检测被**完整执行了两次**！
2. **CI 单 Job 串行执行导致反馈周期冗长**：
   - `.github/workflows/quality.yml` 目前在单个 `validate` Job 中按顺序串行跑：
     `npm ci` → `build` → `check` → `vitest --coverage` → `test:unit` → `test:contract` → `playwright e2e`。
   - 单次流水线耗时经常超过 **20 ~ 25 分钟**，超时设置为 35 分钟。任何第 20 分钟出现的测试微小失败，都会使前面 15 分钟的计算全数作废。

#### 具体提升建议
1. **清理 `run-check-parallel.js` 编排重叠**：
   - 统一收口质量测试，去除多进程重复启动项，预期可直接减少 15%~25% 的本地 `check` 运行耗时。
2. **GitHub Actions 矩阵化并发（Pipeline Parallelization）**：
   将单一 Job 拆分为 4 个并发 Job：
   - **Job 1: Static & Lint** (`npm run check`，含双 typecheck 与 eslint) —— ~3 分钟
   - **Job 2: Unit & Coverage** (`vitest --coverage` + `npm run test:unit`) —— ~4 分钟
   - **Job 3: Contract & Verification** (`npm run test:contract` + `desktop:verify-gateway`) —— ~4 分钟
   - **Job 4: E2E Critical** (依赖 Job 1~3 通过后触发 Playwright 关键路径) —— ~5 分钟
   - **收益**：CI 总体排队与端到端反馈时间由 **25 分钟压缩至 7~9 分钟**。

---

### 维度 6：依赖管理与桌面打包：消除「手工白名单」的静默降级隐患

#### 现状机制与事故复盘
- 项目采用单 `package.json` 全栈模式，混杂前端 UI、本地网关（Express）与原生 AI 推理（`onnxruntime-node`, `sharp`）。
- 桌面打包工具 `scripts/maintenance/desktop-stage-resources.js` 必须手工维护网关依赖白名单：
  ```javascript
  const RUNTIME_DEPENDENCIES = [
    'compression', 'express', 'http-proxy-middleware',
    'onnxruntime-node', 'sharp', 'ws'
  ];
  ```
- **历史严重教训**：
  - *2026-08-29*：`onnxruntime-node` + `sharp` 漏登记，桌面端真实反推静默降级为启发式兜底；
  - *2026-09-06*：`ws` 漏登记，出图进度接口 500 导致桌面端主页崩溃。

#### 具体提升建议
1. **短期防护：自动化依赖一致性门禁（Dependency Consistency Gate）**：
   - 编写轻量门禁 `test-desktop-runtime-deps.js`（纳入 `QUALITY_TEST_SUITES.check`）：
   - 静态解析 `server/`、`routes/`、`services/` 的真实 `import` / `require` 调用包名，自动核对是否全部在 `RUNTIME_DEPENDENCIES` 清单中；一旦发现“代码用了但打包白名单没写”，在提交阶段直接阻断报错。
2. **中长期演进：轻量 Monorepo 工作区（npm / pnpm workspaces）**：
   - 将工程拆解为：
     - `apps/web`（前端 Vue 单页）
     - `apps/desktop`（Tauri 2 桌面壳）
     - `packages/gateway`（Node 服务端运行时，拥有专属独立的 `package.json`）
     - `packages/contracts`（数据 Schema 与 API 契约）
   - 各模块的依赖自然隔离，从物理层面消除人工白名单与依赖截取脚本。

---

### 维度 7：测试金字塔倒置：补齐核心 Composable 单测深度

#### 现状数据
- `vitest.config.ts` 中全库单测覆盖率阈值较低：**行覆盖率 17%、分支覆盖率 11%**。
- 前端拥有 160+ 个 Composable，绝大多数处于无专属单元测试状态；
- 系统高度依赖 48 个庞大的 Playwright E2E Spec 文件承担全功能与回归保障。

#### 工程痛点
- 典型的“冰淇淋蛋筒（Ice Cream Cone）/ 倒置金字塔”模式：底层单元测试覆盖薄，顶层 E2E 异常厚重。
- E2E 测试对端口（`AICS_E2E_PORT_OFFSET`）、动画状态、浏览器驱动版本极其敏感，执行成本高昂且排查繁琐。

#### 具体提升建议
- **关键有状态 Composable 实施 Headless 单元测试**：
  - 重点覆盖：`useAnimaSession.ts`、`useSDQueue.ts`、`useCompanionAffection.ts`、`useChatConversation.ts`、`useMasonryWall.ts`。
  - 使用 `@vue/test-utils` 与 Vitest 进行纯状态机变迁与错误分支测试，逐步将 Vitest 覆盖率阈值提升至 **40% ~ 50%**，让绝大多数逻辑边界在毫秒级单测中闭环，降低对大型端到端测试的强耦合。

---

## 三、系统提升行动规划与优先级矩阵

| 优先级 | 优化方向 | 核心措施 | 预期收益 | 复杂度 |
| :---: | :--- | :--- | :--- | :---: |
| **P0** | **动态主题重构** | 剥离 `tokens.css` 中 800+ 行静态角色选择器，改用动态 CSS 变量 + `color-mix` | **释放 Entry CSS 15~20 KiB**，根除 99.1% 预算爆雷风险 | 低 |
| **P0** | **门禁去重与 CI 并发** | 清理 `run-check-parallel` 重复执行项；拆分 `quality.yml` 为 4 并发 Job | 本地 check 提速 25%，**CI 反馈时间由 25m 降至 8m** | 低 |
| **P1** | **`DATA_VERSION` 虚拟化** | 改为 Vite 虚拟模块 `virtual:data-version` 或独立生成文件 | **消除数据构建对 `sceneStore.ts` 源码的写入污染**，防 Git 冲突 | 低 |
| **P1** | **桌面依赖自动门禁** | 增加 `test-desktop-runtime-deps.js` 静态对比代码引用与白名单 | **根绝桌面端依赖漏装导致的静默功能退化** | 低 |
| **P2** | **单体压线文件解耦** | 拆分 `ChatView.vue`（抽离模型/语音控制台）与 `routes/anima.ts` 管线 | 消除 590+ 行临界崩溃风险，建立清晰视图控制器 | 中 |
| **P2** | **服务端 Any 清理** | 建立 `types/contracts/` 共享 DTO，逐步在 `routes/` 消除 391 处 any | 提升后端健壮性，实现前后端接口在编译期类型互锁 | 中 |
| **P3** | **轻量 Monorepo 演进** | 规划 `apps/web`、`apps/desktop`、`packages/gateway` 工作区 | 依赖与构建产物物理隔离，彻底现代化全栈架构 | 较高 |

---

## 四、文档索引与关联

- 本文档归档路径：`docs/archive/audits/engineering-maintainability-audit-2026-09-16.md`
- 关联索引已登记至：[docs/INDEX.md](../../INDEX.md)
- 历史参考对比：
  - [办公机独立全面审计（2026-09-12）](office-independent-audit-2026-09-12.md)
  - [办公机工程债务治理（2026-09-09）](engineering-debt-2026-09-09.md)
  - [办公机工程交付（2026-09-15）](office-engineering-completion-2026-09-15.md)
