# TypeScript 开发与维护

本指南说明源码、运行产物、日常检查与桌面打包之间的关系。工程边界仍以 [工程契约](../../engineering-contracts.md) 为准，命令入口见 [工作流](../../workflow.md)。

## 编辑源码

前端继续由 Vue / Vite 构建，产品网关由 `runtime-rs/` 的 Rust 源码构建。旧 Node 网关/路由已退出；维护脚本、测试及独立浏览器脚本以 `.ts` 为源码；原生 ES 模块使用 `.mts`，明确的 CommonJS 文件使用 `.cts`。第三方 vendor 文件不改写。

Node 与独立浏览器命令使用的 `.js`、`.mjs`、`.cjs` 是构建产物。修改对应 TypeScript 源码，再运行 `npm run build:runtime`；不要直接修改生成文件。这个命令检查和生成 Node/浏览器工具，不构建 Rust 网关；原生 release 构建入口为 `npm run wf -- rust:build`，具体分工见[工作流](../../workflow.md#rust-运行时迁移)。

| 范围 | 类型检查配置 | 输出 |
| --- | --- | --- |
| Vue 前端 | `tsconfig.app.json` | Vite 的 `dist/` |
| Node 维护脚本 | `tsconfig.node.json` | 原位置的运行文件 |
| Node 与前端交叉测试 | `tsconfig.tests.json` | 原位置的测试运行文件 |
| 独立静态页脚本 | `tsconfig.browser-tools.json` | 原位置的浏览器 `.js` |

静态页脚本分别检查，避免将不同页面的全局变量误当成同一程序。Node 维护工具的类型检查沿用项目的 Node 版本要求及 CommonJS / ES 模块边界，不把整个仓库切换成 ES 模块。

测试使用独立的严格检查配置，允许既有测试读取 Vue 前端源码与浏览器类型；Node 工具按其配置检查。测试运行文件仍按 Node 模块格式生成，`.ts` 的 CommonJS 测试与 `.mts` 的原生 ES 模块保持原有入口。所有测试源码都包含在完整检查中。

## 日常循环

首次拉取或依赖变化后执行 `npm ci`。安装后的构建入口直接从 `scripts/build-node.mts` 启动，不依赖尚未生成的维护脚本。

```sh
npm run dev
npm run dev:server
```

前端开发服务与网关可以分别运行。`dev:server` 需要 Rust 工具链，监视 Rust 源码、Cargo 配置、原生数据和应用数据；成功构建后先认证并排空旧网关，再启动独立副本，避免 Windows 锁住下一次构建的 EXE。构建失败保留旧服务；无法确认排空时不启动第二个写入者。退出时关闭监视器并排空子进程。具体入口见[开发网关启动器](../../../scripts/dev-server.mts)。TypeScript 维护脚本的修改仍由 `build:runtime` 生成。

按改动选择检查：

```sh
npm run typecheck:app
npm run typecheck:node
npm run typecheck:tests
npm run typecheck:browser-tools
npm run wf -- check:typescript
npm run wf -- gate:quick --plan
```

`check:typescript` 只检查，不更新运行文件或缓存。`build:runtime` 负责检查和生成 Node/浏览器工具；Rust 行为改动、代码迁移、目录调整和依赖变化按工作流分层选择受影响检查，跨领域契约或构建链变化才在整合节点执行必要的全量门禁。

## 构建与缓存

构建器先检查全部选中项目，再写入产物。一个项目存在类型错误时，其他项目已经计算出的产物也不会提前发布。节点脚本使用完整严格检查与逐文件转换，保留测试直接引用前端 `.ts` 文件的既有路径。

缓存位于被忽略的 `.cache/typescript-build/`。复用条件包括源码和本地类型依赖、编译配置、编译器版本、构建器、依赖锁文件及每份输出的内容哈希。缺失或被修改的输出会触发重建。

```sh
npm run build:runtime
npm run build:runtime -- --force
node scripts/build-node.mts --project node --check
node scripts/build-node.mts --help
```

源文件删除后，仅清理上一次构建记录中、内容未被更改且仍属于本构建器的对应输出。无关文件和手工更改过的旧输出保留，避免误删工作区内容。

## 类型归属

前端角色、服装、场景、生成状态及提示词计划复用 `src/types/` 的业务定义。现存工具和 store 的类型转导出不构成另一份字段表；内部重构清理过时入口，不新增永久 shim。跨端 DTO 放根目录 `types/` 或对应 runtime 纯模块；后端不得反向引用 `src/`，纯类型及间接依赖同样纳入 `check:domain-types` 的重构护栏。

配置类型从配置加载函数的返回值推导；工作流注册元数据由 `scripts/lib/workflow-types.ts` 描述。HTTP、文件和进程等边界使用实际接口。文件内容与外部返回值仍需要运行时校验，类型声明不代替数据验证。

捕获的异常不假设一定是 `Error`。通用错误字段读取集中在 `scripts/lib/runtime-errors.ts`；原始错误仍按原调用链传递。

## 验证与桌面产物

`check:typescript-build` 使用临时夹具验证构建、失效条件和开发重启，不访问实际模型或安装目录。源码检查通过仍需对应行为回归；测试中的非法输入应明确表达测试边界，不通过删除断言来满足类型签名。

桌面准备入口构建 Rust release 网关与桌面前端，再暂存 `gateway/huiyu-runtime.exe`、原生依赖和资源清单。成品不携带 Node sidecar，也不以旧 Node 网关生成文件启动服务。Node 仍用于源码维护及构建编排；原生准备见[prepare-tauri](../../../scripts/maintenance/prepare-tauri.ts)。安装、UAC、WebView2、GPU 和真实模型验收保持原分工，源码检查与暂存校验不代表这些设备项目已经验收。

## 工具链支持责任

源码开发工具最低版本保持 package.json 的 Node >=22.18；开发与 Quality 使用 24.18.0（.nvmrc、quality.yml）。这些要求不适用于普通桌面安装机：产品网关使用 Rust，无需安装 Node。最低 Node 版本在 Quality 独立执行锁定安装、前端生产构建及现行工具边界检查，结果参与总门禁；它不是 Rust 或目标设备验收，不能用开发机 Node 24 的通过代替最低版本验证。

@types/node 26 是声明来源，不是运行时承诺；运行版本以锁文件与依赖声明为准。引入新 Node API 时需在最低运行时补回归，类型检查本身不能证明该 API 已存在。

ESLint 编辑入口为 eslint.config.mts；eslint.config.js 仅转发到该源码，避免两份配置漂移。生成 JS 不作为源码 lint；浏览器/服务的关键环境误用由 no-restricted-globals 与各 tsc 配置共同检查，正反例在 test-module-boundaries.mts。单体 500 有效行上限由 test-monolith-budget.ts 维护，存量超限文件按 monolith-baseline.json 只降不升。

## 参考

- [TypeScript 模块系统与 CommonJS / ESM 互操作](https://www.typescriptlang.org/docs/handbook/modules/reference.html#node16-node18-node20-nodenext)
- [Node.js 22 的 TypeScript 支持与限制](https://nodejs.org/docs/latest-v22.x/api/typescript.html)

原生类型擦除不执行类型检查，也不读取 `tsconfig`。因此这里的原生启动入口仍调用严格检查的构建器；业务运行文件继续经过受控转换。
