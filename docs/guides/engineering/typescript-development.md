# TypeScript 开发与维护

本指南说明源码、运行产物、日常检查与桌面打包之间的关系。工程边界仍以 [工程契约](../../engineering-contracts.md) 为准，命令入口见 [工作流](../../workflow.md)。

## 编辑源码

前端继续由 Vue / Vite 构建。网关、路由、维护脚本、测试及独立浏览器脚本以 `.ts` 为源码；原生 ES 模块使用 `.mts`，明确的 CommonJS 文件使用 `.cts`。第三方 vendor 文件不改写。

运行命令使用的 `.js`、`.mjs`、`.cjs` 是构建产物。修改对应 TypeScript 源码，再运行 `npm run build:runtime`；不要直接修改生成文件。现有网关路由、命令参数、测试入口和桌面资源路径保持兼容。

| 范围 | 类型检查配置 | 输出 |
| --- | --- | --- |
| Vue 前端 | `tsconfig.app.json` | Vite 的 `dist/` |
| 现有服务 | `tsconfig.runtime.json` | `services/` 内 `.js` 和 `.d.ts` |
| 网关、路由及维护 | `tsconfig.node.json` | 原位置的运行文件 |
| Node 与前端交叉测试 | `tsconfig.tests.json` | 原位置的测试运行文件 |
| 独立静态页脚本 | `tsconfig.browser-tools.json` | 原位置的浏览器 `.js` |

静态页脚本分别检查，避免将不同页面的全局变量误当成同一程序。后端类型检查沿用项目的 Node 版本要求及 CommonJS / ES 模块边界，不把整个仓库切换成 ES 模块。

测试使用独立的严格检查配置，允许既有测试读取 Vue 前端源码与浏览器类型；网关继续按 NodeNext 检查。测试运行文件仍按 Node 模块格式生成，`.ts` 的 CommonJS 测试与 `.mts` 的原生 ES 模块保持原有入口。所有测试源码都包含在完整检查中。

## 日常循环

首次拉取或依赖变化后执行 `npm ci`。安装后的构建入口直接从 `scripts/build-node.mts` 启动，不依赖尚未生成的维护脚本。

```sh
npm run dev
npm run dev:server
```

前端开发服务与网关可以分别运行。网关开发入口监视 TypeScript 和构建配置：类型检查成功、产物更新后重启；检查失败时输出错误并保留上一次运行的网关。修正源码后继续构建。退出时关闭监视器和子进程。

按改动选择检查：

```sh
npm run typecheck:app
npm run typecheck:node
npm run typecheck:tests
npm run typecheck:browser-tools
npm run wf -- check:typescript
npm run wf -- gate:quick --plan
```

`check:typescript` 只检查，不更新运行文件或缓存。`build:runtime` 负责检查和生成；代码迁移、目录调整或依赖变化仍按工作流执行完整门禁。

## 构建与缓存

构建器先检查全部选中项目，再写入产物。一个项目存在类型错误时，其他项目已经计算出的产物也不会提前发布。节点脚本使用完整严格检查与逐文件转换，保留测试直接引用前端 `.ts` 文件的既有路径。

缓存位于被忽略的 `.cache/typescript-build/`。复用条件包括源码和本地类型依赖、编译配置、编译器版本、构建器、依赖锁文件及每份输出的内容哈希。缺失或被修改的输出会触发重建。

```sh
npm run build:runtime
npm run build:runtime -- --force
node scripts/build-node.mts --project services --check
node scripts/build-node.mts --help
```

源文件删除后，仅清理上一次构建记录中、内容未被更改且仍属于本构建器的对应输出。无关文件和手工更改过的旧输出保留，避免误删工作区内容。

## 类型归属

角色、服装、场景、生成状态及提示词计划复用 `src/types/` 的实际业务定义。原工具和 store 的类型导出保留兼容入口，不重复维护另一份字段表。仅需类型的后端模块直接引用纯类型文件，避免把 Vue 状态模块引入网关。

配置类型从配置加载函数的返回值推导；工作流注册元数据由 `scripts/lib/workflow-types.ts` 描述。HTTP、文件和进程等边界使用实际接口。文件内容与外部返回值仍需要运行时校验，类型声明不代替数据验证。

捕获的异常不假设一定是 `Error`。通用错误字段读取集中在 `scripts/lib/runtime-errors.ts`；原始错误仍按原调用链传递。

## 验证与桌面产物

`check:typescript-build` 使用临时夹具验证构建、失效条件和开发重启，不访问实际模型或安装目录。源码检查通过仍需对应行为回归；测试中的非法输入应明确表达测试边界，不通过删除断言来满足类型签名。

桌面暂存复制生成的运行文件，排除 TypeScript 源码和 source map；服务输出继续使用既有清单校验。安装、UAC、WebView2、GPU 和真实模型验收保持原分工，迁移源码不代表这些设备项目已经验收。

## 参考

- [TypeScript 模块系统与 CommonJS / ESM 互操作](https://www.typescriptlang.org/docs/handbook/modules/reference.html#node16-node18-node20-nodenext)
- [Node.js 22 的 TypeScript 支持与限制](https://nodejs.org/docs/latest-v22.x/api/typescript.html)

原生类型擦除不执行类型检查，也不读取 `tsconfig`。因此这里的原生启动入口仍调用严格检查的构建器；业务运行文件继续经过受控转换。
