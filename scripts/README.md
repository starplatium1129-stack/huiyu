# 脚本目录

脚本按是否参与当前产品运行与维护分层，避免一次性实验和日常命令混在一起。

- `lib/`：网关、维护流程与测试共用的基础模块。
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

网关及 Node 维护/测试脚本以 `.ts`/`.mts`/`.cts` 为源码；`npm run build:runtime` 生成命令执行的 `.js`/`.mjs`/`.cjs`，不要手改产物。Python、PowerShell 等脚本继续编辑原文件。一次性实验归入被忽略的 `scripts/archive/`，与受控的 `training/` 脚本区分；旧实验可从 Git 历史查找。
