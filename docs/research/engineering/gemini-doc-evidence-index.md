# Gemini 文档证据索引复核

复核日期：2026-09-13。状态：**仅源码与文档核对**。本报告不代表设备、图片、安装或运行测试通过。机器可读内容见 [JSON](gemini-doc-evidence-index.json)。

共核对 8 份文档；日期只采用原文明确标注，不推断其对应发布版本。

## 热门角色接入工作流

- 文档：`docs/guides/characters/character-onboarding-workflow.md`
- 时效：页首日期 2026-09-08；当前入口说明
- 入口：`character:onboard`

文档实际使用 character:onboard，兼容脚本为 workflow-onboard-popular-character.js。原报告的 char:onboard / onboard-character.js 不来自原文，撤回命令路径漂移结论。

证据：`scripts/workflow.js`、`package.json`、`scripts/maintenance/workflow-onboard-popular-character.js`。

范围限制：注册项与 package.json 命令目标一致；未执行接入或生成。

## 角色点阵粒子管线（操作手册）

- 文档：`docs/guides/characters/particle-portrait-pipeline.md`
- 时效：2026-09-09 当前入口；2026-08-16 历史实验
- 入口：`npm run particles:build`

当前组件入口为 PopularSceneExplorerView.vue → SemanticParticleField.vue，后者引用 particlePortrait 工具。历史像素实验和性能描述不能当作本轮测量。

证据：`package.json`、`scripts/maintenance/build-particle-portraits.py`、`src/views/PopularSceneExplorerView.vue`、`src/components/visual/SemanticParticleField.vue`、`src/utils/particlePortrait.ts`。

范围限制：仅核对调用与路径；未重建点云、未全库重算哈希或验证渲染。

## 场景维护工作台重构 · 1.5.7

- 文档：`docs/guides/characters/scene-maintenance-workspace.md`
- 时效：v1.5.7 历史重构记录
- 入口：`/scene-manager`

路由由 src/router/index.ts 注册到 SceneManagerView.vue。原报告的 /scenes 不正确；历史验证不代表当前保存实现全部通过。后续保存审计另见 scene-save-review-2026-09-13.md。

证据：`src/router/index.ts`、`src/views/SceneManagerView.vue`、`docs/archive/audits/scene-save-review-2026-09-13.md`。

范围限制：核对路由与文档适用范围；未重跑 UI 或保存测试。

## 视觉资产审核历史宪章

- 文档：`docs/guides/characters/quality-audit-standards-charter.md`
- 时效：v1.5.0 批次；2026-09-12 时效说明
- 入口：`AGENTS.md`

页首明确将741个场景与通过率限定为历史批次；不能用档案目录存在证明数字或人工裁定。

证据：`AGENTS.md`。

范围限制：本轮确认时效说明存在；未复核历史图片、数量或裁定。

## 绫季绘境 · 现代安装界面

- 文档：`docs/guides/desktop/game-installer.md`
- 时效：当前构建指南与历史发行记录并存
- 入口：`installer:modern / installer:bundle`

文档区分现代展示层和 package:tauri 产生的 NSIS 核心；不能把源码或历史截图文件存在写成当前安装器已通过。

证据：`scripts/workflow.js`、`desktop-tauri/src-tauri/installer/modern/Installer.xaml`、`desktop-tauri/src-tauri/installer/modern/InstallerWindow.cs`、`desktop-tauri/src-tauri/installer/modern/InstallEngine.cs`。

范围限制：核对文档与入口注册、源码分工；未编译预览、运行安装或查看原生效果。

## 桌宠 DSH 架构对齐与配置指南

- 文档：`docs/guides/desktop/companion-dsh-agent-architecture.md`
- 时效：2026-08-20 基线，含后续权限调整说明
- 入口：`/companion / /companion-chat`

路由已注册。文档声称的历史实机 PASS 不能由视图文件存在证明；抓屏、工具调用与音频链路需分别核验。

证据：`src/router/index.ts`、`src/views/CompanionView.vue`、`src/views/CompanionChatView.vue`。

范围限制：仅核对路由与历史声明范围；未验证好感度、工具调用或本机 Live2D。

## Live2D 原生运行时

- 文档：`docs/guides/desktop/live2d-native-runtime.md`
- 时效：2026-09-12 更新；历史验收另有限定
- 入口：`npm run test:live2d-native`

package.json 对应 run-live2d-selftest.js --release。原报告虚构了 src-tauri/cubism-native 依赖路径；实际 crate 为 desktop-tauri/native-live2d。构建脚本检查显式 SDK 配置、仓库 runtime 位置及历史路径，部署文档已说明 SDK 配置。不存在所谓内部目录不证明依赖缺失。

证据：`package.json`、`scripts/tests/run-live2d-selftest.js`、`desktop-tauri/src-tauri/Cargo.toml`、`desktop-tauri/native-live2d/build.rs`、`docs/desktop-deployment.md`。

范围限制：核对构建解析规则；未判断此机器SDK完整性，未执行原生测试。

## 桌面端部署：增量 还是 完整安装

- 文档：`docs/desktop-deployment.md`
- 时效：当前入口与历史故障说明并存
- 入口：`deploy-desktop.bat`

批处理调用 deploy-desktop-quick.ps1 并默认传入 -Cleanup。脚本声明 SkipBuild / Cleanup / UseInstaller 参数。只证明这些入口和参数对齐，不声称全部部署行为高度一致或执行通过。

证据：`deploy-desktop.bat`、`scripts/maintenance/deploy-desktop-quick.ps1`。

范围限制：未运行部署、停止应用、清缓存、安装或发布。

## 更正记录

- 撤回伪造命令引文、/scenes 路由与 SDK 内部目录缺失结论。
- 删除未重新核实的粒子哈希覆盖数量、版本推断和全部参数高度一致表述。
- 删除把历史截图、文件或目录存在写成验证通过的结论。
