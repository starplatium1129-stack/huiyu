# 脚本目录

整理日期：2026-10-09。脚本按当前维护职责分层，产品网关位于 runtime-rs/。

- `lib/`：维护流程、离线生成工具与测试共用的基础模块，不承接产品 HTTP 网关。
- `maintenance/`：场景构建、校验、审图、样张与性能诊断工具。
- `tests/`：`npm run validate` 及各专项测试使用的回归脚本。
- `fixtures/`：测试与校验用的固定样例数据。
- `contracts/`：数据与接口结构契约。
- `training/`：保留在库中的专用训练准备与校验脚本。

日常操作先用统一工作流查入口，再使用已登记命令：

```powershell
npm run wf -- --help
npm run validate
npm run wf -- content:catalog --help
npm run benchmark:voice
```

内容维护以运行目录 `content/catalog.sqlite` 为权威，通过 `content:catalog` 预览、写入并显式导出项目快照；`legacy:*` 仅供未迁移旧资料的升级整理，已迁移项目拒绝回写分片。详见[维护手册](../docs/maintenance.md)。

Node 维护/测试脚本以 `.ts`/`.mts`/`.cts` 为源码；仅工具源/配置变化或所需入口缺失时运行 `npm run build:runtime` 生成 `.js`/`.mjs`/`.cjs`，不要手改产物。Rust 网关独立构建，Python、PowerShell 脚本直接编辑原文件。一次性实验归入被忽略的 `scripts/archive/`，与受控的 `training/` 脚本区分；旧实验可从 Git 历史查找。
