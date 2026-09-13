#!/usr/bin/env node
'use strict';

/**
 * scripts/workflow.js — 统一工作流入口
 *
 * 解决：maintenance 脚本分散、入口难发现、参数不统一。
 * 用法：
 *   node scripts/workflow.js --help
 *   node scripts/workflow.js <group> --help
 *   node scripts/workflow.js <group>:<action> [options]
 *   npm run workflow -- <group>:<action> [options]
 *
 * 设计：薄封装，不接管业务逻辑，仅做发现、校验与转发，
 * 保持对现有脚本的完全兼容（直接 node 旧脚本仍可用）。
 *
 * 运行条件元数据（计划 006 W1，2026-09-13）：
 *   每个注册项的 run 字段是 help / plan / audit:workflows 共用的结构化描述，
 *   只用于展示与审计，runner 不据此拦截或改写执行（无运行时策略）。
 *   - nature：默认（不带开关）行为的 facet，多值；枚举见 scripts/lib/workflow-runner.js EFFECTS
 *   - machine：运行环境要求，多值；枚举见 MACHINES
 *   - switches：显式开关改变的行为（值同样用 EFFECTS）；runner 级 --plan/--help 不在此列
 *   - resume：idempotent（重跑覆盖/等价）| checkpoint（按已完成条目断点续跑）| na
 *   - evidence：结论的核实位置（文件:行）；unknown：未核实点，不猜
 *   - notes：已确证但待主任务处理的缺陷登记（不改执行）
 *   复合（steps）工作流的 nature 必须覆盖各子步骤，不得只标 read-only；
 *   audit:workflows 校验以上全部约束。
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const WORKFLOWS = {
  'showcase:review-sheets': { desc: '从候选审核目录生成逐图查看用联系表', cmd: ['python', 'scripts/maintenance/build-scene-manual-audit-sheets.py'], required: ['--audit'], docs: 'docs/workflow.md',
    run: { nature: ['writes-product'], machine: ['python-pillow'], switches: {}, resume: 'idempotent', evidence: 'scripts/maintenance/build-scene-manual-audit-sheets.py:134-162', unknown: [], notes: ['输出写在 --audit 目录下，通常在仓库外'] } },
  'showcase:manual-review': { desc: '汇总明确人工决定；缺少决定的图片保持 pending', cmd: ['node', 'scripts/maintenance/build-scene-manual-review.js'], required: ['--manifest', '--decisions'], docs: 'docs/workflow.md',
    run: { nature: ['writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'scripts/maintenance/build-scene-manual-review.js:41-66', unknown: [] } },
  'showcase:scene-publish': { desc: '旧独立场景发布器：校验逐图审核后预览；--apply 写新版本', cmd: ['node', 'scripts/maintenance/publish-scene-showcase-anima11.js'], required: ['--from', '--source', '--target'], docs: 'docs/workflow.md',
    run: { nature: ['preview'], machine: ['node', 'python-pillow'], switches: { '--apply': ['writes-release'], '--force': ['delete', 'writes-release'] }, resume: 'idempotent', evidence: 'scripts/maintenance/publish-scene-showcase-anima11.js:506-509,511-555', unknown: [] } },
  'showcase:rating-refresh': { desc: '仅刷新发布清单分级，默认预览；--apply 写新版本', cmd: ['node', 'scripts/maintenance/publish-rating-refresh.js'], required: ['--source', '--target'], docs: 'docs/workflow.md',
    run: { nature: ['preview'], machine: ['node'], switches: { '--apply': ['writes-release'], '--force': ['delete', 'writes-release'] }, resume: 'idempotent', evidence: 'scripts/maintenance/publish-rating-refresh.js:193-213', unknown: [] } },
  'reference:repair-urls': { desc: '参考 URL 迁移修复并备份；先传 --dry-run 核对清单', cmd: ['node', 'scripts/maintenance/repair-character-reference-urls.js'], docs: 'docs/workflow.md',
    run: { nature: ['writes-source'], machine: ['node'], switches: { '--dry-run': ['preview'] }, resume: 'idempotent', evidence: 'scripts/maintenance/repair-character-reference-urls.js:80,139-142,191-192', unknown: [] } },
  'models:download-h3': { desc: '下载 H3 可选模型（大文件；--models-root 指定目录）', cmd: ['node', 'scripts/maintenance/download-minimax-h3.js'], required: ['--models-root'], docs: 'docs/workflow.md',
    run: { nature: ['network-download', 'writes-product'], machine: ['node', 'network'], switches: {}, resume: 'checkpoint', evidence: 'scripts/maintenance/download-minimax-h3.js:51-54,72,104', unknown: [], notes: ['约 44GB；中断文件重跑从零重下，已完成文件跳过'] } },
  'desktop:verify-gateway': { desc: '按安装包资源映射隔离验证网关和桌宠页面', cmd: ['node', 'scripts/maintenance/verify-desktop-gateway.js'], docs: 'docs/desktop-deployment.md',
    run: { nature: ['isolated-fixture', 'service'], machine: ['windows', 'node'], switches: {}, resume: 'idempotent', evidence: 'scripts/maintenance/verify-desktop-gateway.js:47-85', unknown: [] } },
  'desktop:doctor': { desc: '检查 Windows 桌面打包工具链与 Cubism SDK', cmd: ['node', 'scripts/maintenance/desktop-build-environment.js'], docs: 'docs/desktop-deployment.md',
    run: { nature: ['read-only'], machine: ['windows', 'node'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/desktop-build-environment.js:39-64', unknown: [] } },
  'desktop:storage-benchmark': { desc: '用临时库和私有浏览器比较 IndexedDB 与 SQLite 原型，不访问用户数据', cmd: ['node', 'scripts/tests/prototypes/benchmark-artwork-storage.js'], docs: 'plans/005-desktop-architecture-consolidation.md',
    run: { nature: ['isolated-fixture'], machine: ['node', 'playwright-browser'], switches: {}, resume: 'idempotent', evidence: 'scripts/tests/prototypes/benchmark-artwork-storage.js:56-135', unknown: [] } },
  'desktop:package-local': { desc: '跳过压缩生成本机测试安装包', cmd: ['npm', 'run', 'package:tauri', '--', '--config', 'tauri.local.json'], docs: 'docs/desktop-deployment.md',
    run: { nature: ['writes-release'], machine: ['windows', 'windows-toolchain'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.package:tauri; scripts/maintenance/run-tauri.js:17', unknown: [] } },
  'brand:build': { desc: '从手绘 SVG 母版生成绘遇字标、网站与桌面图标', cmd: ['node', 'scripts/maintenance/build-brand-assets.js'], docs: 'docs/workflow.md',
    run: { nature: ['writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'scripts/maintenance/build-brand-assets.js:17-26', unknown: [] } },
  'docs:check': { desc: '检查文档文件链接与旧地址映射', cmd: ['node', 'scripts/maintenance/check-doc-links.js'], docs: 'docs/workflow.md',
    run: { nature: ['read-only'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/check-doc-links.js:38', unknown: [] } },
  'audit:workflows': { desc: '只读审计注册入口、npm 脚本、文档及复合依赖', builtin: 'audit', docs: 'docs/workflow.md',
    run: { nature: ['read-only'], machine: ['node'], switches: { '--json': ['read-only'] }, resume: 'na', evidence: 'scripts/lib/workflow-runner.js:7-21', unknown: [] } },
  'check:workflows': { desc: '工作流执行与门禁路由回归测试', cmd: ['node', 'scripts/tests/test-workflow-runner.js'], docs: 'docs/workflow.md',
    run: { nature: ['isolated-fixture'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'scripts/tests/test-workflow-runner.js:13-108', unknown: [] } },
  'dev:web': { desc: '启动前端开发服务', cmd: ['npm', 'run', 'dev'], docs: 'docs/workflow.md',
    run: { nature: ['service'], machine: ['node'], switches: {}, resume: 'na', evidence: 'package.json scripts.dev', unknown: [] } },
  'dev:server': { desc: '编译并启动网关', cmd: ['npm', 'start'], docs: 'docs/workflow.md',
    run: { nature: ['service', 'writes-product'], machine: ['node'], switches: {}, resume: 'na', evidence: 'package.json scripts.start/prestart', unknown: [], notes: ['prestart 每次重编译 services/*.js；网关启动按需自愈重建缺失数据产物'] } },
  'installer:modern': {
    desc: '构建现代原生安装器（--preview --capture 可安全预览，不安装）',
    cmd: ['node', 'scripts/maintenance/build-modern-installer.js'],
    docs: 'docs/guides/desktop/game-installer.md',
    run: { nature: ['writes-release'], machine: ['windows', 'windows-toolchain'], switches: { '--preview': ['writes-product'], '--capture': ['writes-product'] }, resume: 'idempotent', evidence: 'scripts/maintenance/build-modern-installer.js:10-13,44-70', unknown: ['--capture 截图落盘位置未逐行核实'] },
  },
  'installer:bundle': {
    desc: '仅重打包已构建的桌面程序并签名（只改安装界面时使用）',
    cmd: ['node', 'scripts/maintenance/release-desktop-update.js', '--bundle-only'],
    docs: 'docs/guides/desktop/game-installer.md',
    run: { nature: ['writes-release'], machine: ['windows', 'windows-toolchain'], switches: { '--publish': ['publish-remote'], '--bump': ['writes-source'] }, resume: 'idempotent', evidence: 'scripts/maintenance/release-desktop-update.js:33-39,76-86,215-242', unknown: [], notes: ['--publish 推送 GitHub Releases（外部发布）；需 updater 签名私钥'] },
  },
  'installer:build': {
    desc: '构建二游风格原生安装界面（固定版本 Tauri 模板）',
    cmd: ['node', 'scripts/maintenance/build-game-installer.js'],
    docs: 'docs/guides/desktop/game-installer.md',
    run: { nature: ['writes-release'], machine: ['windows', 'windows-toolchain'], switches: { '--preview': ['writes-product'] }, resume: 'idempotent', evidence: 'scripts/maintenance/build-game-installer.js:75-106', unknown: ['capture 模式隐藏启动界面截屏的完整生命周期未逐行核实'] },
  },
  'installer:preview': {
    desc: '编译安全界面预览（不安装、不提权；--page=welcome|directory|install|finish|maintenance）',
    cmd: ['node', 'scripts/maintenance/build-game-installer.js', '--preview'],
    docs: 'docs/guides/desktop/game-installer.md',
    run: { nature: ['writes-product'], machine: ['windows', 'windows-toolchain'], switches: { '--capture': ['writes-product'] }, resume: 'idempotent', evidence: 'scripts/maintenance/build-game-installer.js:122-124', unknown: [] },
  },
  'data:build': {
    desc: '聚合场景分片 -> scenes.json（热门角色见 popular:build）',
    cmd: ['node', 'scripts/maintenance/build-scenes.js'],
    docs: 'docs/maintenance.md#文件职责',
    run: { nature: ['writes-product', 'writes-source'], machine: ['node'], switches: { '--check': ['self-heal-missing', 'guard'] }, resume: 'idempotent', evidence: 'scripts/maintenance/build-scenes.js:15-42', unknown: [], notes: ['--check：产物缺失时落盘自愈重建（fresh clone）；已构建但与源不一致时报错退出 1；写 src/stores/sceneStore.ts 的 DATA_VERSION'] },
  },
  'popular:build': {
    desc: '聚合热门角色分片 -> popular-characters.json',
    cmd: ['node', 'scripts/maintenance/build-popular.js'],
    docs: 'docs/maintenance.md#文件职责',
    run: { nature: ['writes-product', 'writes-source'], machine: ['node'], switches: { '--check': ['self-heal-missing', 'guard'] }, resume: 'idempotent', evidence: 'scripts/maintenance/build-popular.js:12-37', unknown: [] },
  },
  'popular:split': {
    desc: 'popular→分片（仅写分片文件，不重建聚合；如需重建用 popular:import）',
    cmd: ['node', 'scripts/maintenance/split-popular.js', '--write'],
    docs: 'docs/maintenance.md',
    run: { nature: ['guard'], machine: ['node'], switches: { '--write': ['writes-source'] }, resume: 'idempotent', evidence: 'scripts/maintenance/split-popular.js:4-6', unknown: [], notes: ['缺 --write 直接拒绝退出 1；注册命令已固定 --write'] },
  },
  'popular:import': {
    desc: 'popular→分片+重建聚合（popular:split 超集，从聚合文件导入；改分片用 build）',
    cmd: ['npm', 'run', 'popular:import'],
    docs: 'docs/maintenance.md',
    run: { nature: ['writes-source', 'writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.popular:import（split-popular --write && build-popular）', unknown: [], notes: ['从聚合反向覆盖分片，先核对 diff'] },
  },
  'blueprints:build': {
    desc: '聚合场景蓝图分片 -> scene-blueprints.json',
    cmd: ['node', 'scripts/maintenance/build-blueprints.js'],
    docs: 'docs/maintenance.md#文件职责',
    run: { nature: ['writes-product', 'writes-source'], machine: ['node'], switches: { '--check': ['self-heal-missing', 'guard'] }, resume: 'idempotent', evidence: 'scripts/maintenance/build-blueprints.js:24-49', unknown: [] },
  },
  'blueprints:split': {
    desc: 'blueprints→分片（仅写分片文件，不重建聚合；如需重建用 blueprints:import）',
    cmd: ['node', 'scripts/maintenance/split-blueprints.js', '--write'],
    docs: 'docs/maintenance.md',
    run: { nature: ['guard'], machine: ['node'], switches: { '--write': ['writes-source'] }, resume: 'idempotent', evidence: 'scripts/maintenance/split-blueprints.js:11-13', unknown: [] },
  },
  'blueprints:import': {
    desc: 'blueprints→分片+重建聚合（blueprints:split 超集，从聚合文件导入；改分片用 build）',
    cmd: ['npm', 'run', 'blueprints:import'],
    docs: 'docs/maintenance.md',
    run: { nature: ['writes-source', 'writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.blueprints:import（split-blueprints --write && build-blueprints）', unknown: [] },
  },
  'data:import': {
    desc: 'scenes.json -> 分片 + 重建聚合（覆盖写入）',
    cmd: ['npm', 'run', 'scenes:import'],
    docs: 'docs/maintenance.md',
    run: { nature: ['writes-source', 'writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.scenes:import（split-scenes --write && build-scenes）', unknown: [], notes: ['writeSceneShards 按 ID 排序重切全部分组，中间插入/退役会移动后续批次条目（计划 006 D5）'] },
  },
  'data:normalize': {
    desc: '分类评级 + 规范标签 + 校验',
    cmd: ['npm', 'run', 'scenes:normalize'],
    docs: 'package.json',
    run: { nature: ['writes-source'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.scenes:normalize（classify-scene-ratings --write && optimize-scenes --write && validate-scenes）', unknown: [], notes: ['末段 validate-scenes 只读；分级脚本只维护分级元数据不改写 negative；定稿保护拦截受保护字段'] },
  },
  'data:validate': {
    desc: '内容契约 + DATA_VERSION 校验',
    cmd: ['node', 'scripts/maintenance/validate-content-contracts.js'],
    docs: 'docs/maintenance.md',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/validate-content-contracts.js:22-25', unknown: [] },
  },
  'data:apply': {
    desc: '合并 refine-map chunks (替代 4 个 apply-*.js)',
    cmd: ['node', 'scripts/maintenance/apply-chunks.js'],
    docs: 'scripts/maintenance/apply-chunks.js:1',
    opts: '--target popular|scenes --chunks 1-17',
    run: { nature: ['writes-source'], machine: ['node'], switches: { '--help': ['read-only'] }, resume: 'idempotent', evidence: 'scripts/maintenance/apply-chunks.js:110,147', unknown: ['--target/--chunks 合法性由脚本自校验，注册表未声明 required'] },
  },
  'reference:register': {
    desc: '登记尚无参考资产的角色形态（standards/view 形态集合对账，pending 占位不制造断链）',
    cmd: ['node', 'scripts/maintenance/register-pending-reference-outfits.js'],
    docs: 'scripts/maintenance/register-pending-reference-outfits.js:1',
    opts: '[--dry-run] [--ids=a,b,c] 默认处理所有「standards 空 + view 已有形态」的角色；登记后仍需 reference:render 出图',
    run: { nature: ['writes-source'], machine: ['node'], switches: { '--dry-run': ['preview'] }, resume: 'idempotent', evidence: 'scripts/maintenance/register-pending-reference-outfits.js:108-114', unknown: [], notes: ['默认（无 --dry-run）即写 standards 与 view；pending 不算已交付资产'] },
  },
  'reference:render': {
    desc: '参考库批量出图（按当前角色与服装索引）（MiaoMiao v1.2 832x1216, 并发3）',
    cmd: ['node', 'scripts/maintenance/render-all-outfits-references.js'],
    docs: 'docs/workflow.md#参考库',
    needs: 'ComfyUI + gateway http://127.0.0.1:3000',
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'node'], switches: {}, resume: 'checkpoint', evidence: 'scripts/maintenance/render-all-outfits-references.js:26,149-183', unknown: [], notes: ['脚本默认端点为 3123（确证问题 C1，登记主任务）：需 GATEWAY_URL/BASE 指向 3000 才符合本 needs 描述'] },
  },
  'reference:audit': {
    desc: '纯视觉审核 4并发 (Gemini)',
    cmd: ['node', 'scripts/maintenance/pure-vision-audit.js'],
    docs: 'docs/workflow.md#参考库',
    opts: '[--force] [--keys char/outfit/pers,...] 强制重审指定项',
    run: { nature: ['external-model', 'writes-product'], machine: ['vision-api', 'node'], switches: { '--force': ['external-model', 'writes-product'] }, resume: 'checkpoint', evidence: 'scripts/maintenance/pure-vision-audit.js:47-48', unknown: [], notes: ['视觉后端=本地 CLIProxyAPI 127.0.0.1:8317/v1（gemini-3.7-flash-high，回退 8000）'] },
  },
  'reference:repair': {
    desc: '定向修复未通过项（每项3次重渲染+重审）',
    cmd: ['node', 'scripts/maintenance/fine-tuned-repair.js'],
    docs: 'docs/workflow.md#参考库',
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'node'], switches: {}, resume: 'checkpoint', evidence: 'scripts/maintenance/fine-tuned-repair.js:35,41,184', unknown: [] },
  },
  'reference:design': {
    desc: '三视图设计图批量渲染（增量默认跑 pending，--all 重跑）',
    cmd: ['node', 'scripts/maintenance/render-design-sheets.js'],
    docs: 'docs/workflow.md#参考库',
    opts: '[--chars=a,b] [--outfits=x,y] [--views=f,s,b] [--all] [--dry-run] [--limit=N]',
    needs: 'ComfyUI http://127.0.0.1:8188（--disable-smart-memory）',
    run: { nature: ['external-model', 'writes-product', 'writes-source'], machine: ['comfyui', 'node'], switches: { '--dry-run': ['preview'], '--limit': ['external-model'] }, resume: 'checkpoint', evidence: 'scripts/maintenance/render-design-sheets.js:48,302-306,366', unknown: [], notes: ['出图后回填 view.json url（writes-source）'] },
  },
  'reference:full': {
    desc: '参考库全链路：render -> audit -> repair',
    cmd: null,
    docs: 'docs/workflow.md#参考库',
    steps: ['reference:render', 'reference:audit', 'reference:repair'],
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'vision-api', 'node'], switches: {}, resume: 'checkpoint', evidence: 'scripts/workflow.js:145-150; scripts/lib/workflow-runner.js:23-30', unknown: [], notes: ['复合：不接受公共参数，子步骤失败即停；发布语义见各子项'] },
  },
  'showcase:generate': {
    desc: 'Anima 热门角色 × 蓝图候选出图',
    cmd: ['node', 'scripts/maintenance/generate-popular-showcase-anima11.js'],
    docs: 'docs/archive/troubleshooting/showcase-generation-craft.md',
    required: ['--output'],
    opts: '--output <候选目录> --gateway http://127.0.0.1:3000 --keys popular:角色:蓝图 --model anima-miaomiao-v1.2 --concurrency 3',
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'node'], switches: {}, resume: 'checkpoint', evidence: 'scripts/maintenance/generate-popular-showcase-anima11.js:16-18,44-49', unknown: [], notes: ['写仓库外 ../AI/Reviews/... 候选目录；assertIsolated 拒写公共 showcase'] },
  },
  'showcase:batch-miaomiao': {
    desc: 'MiaoMiao v1.2 全库场景样张批量生成与自动发布流水线（832x1216/1216x832，3并发）',
    cmd: ['node', 'scripts/maintenance/generate-all-scenes-showcase-miaomiao.js'],
    docs: 'docs/archive/troubleshooting/showcase-generation-craft.md',
    opts: '[--force] [--character <id>] [--limit <n>]',
    run: { nature: ['external-model', 'writes-product', 'writes-release'], machine: ['gateway', 'node', 'python-pillow'], switches: { '--force': ['external-model', 'writes-product'] }, resume: 'checkpoint', evidence: 'scripts/maintenance/generate-all-scenes-showcase-miaomiao.js:30,44-45,370', unknown: [], notes: ['默认端点 3123（C1）；直写固定版本目录 AI/SceneShowcase/2026-09-02_v27-miaomiao（C3），待主任务处理'] },
  },
  'showcase:scene-candidates': {
    desc: '独立场景 MiaoMiao v1.2 候选生成（仅指定 ID，不发布）',
    cmd: ['node', 'scripts/maintenance/generate-scene-showcase-anima11.js', '--model', 'anima-miaomiao-v1.2'],
    docs: 'docs/workflow.md#样张',
    required: ['--output', '--ids'],
    opts: '--output <候选目录> --ids sc001,sc002 [--concurrency 1] [--dry-run]',
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'node'], switches: { '--dry-run': ['preview'] }, resume: 'checkpoint', evidence: 'scripts/maintenance/generate-scene-showcase-anima11.js:71-77,269-285', unknown: [] },
  },
  'showcase:fill-gaps': {
    desc: '样张缺口补齐：对照活跃版本manifest批量渲染缺失的pc_<角色>_<场景>样张（miaomiao v1.2，按蓝图recommendedSize出图，并发3）',
    cmd: ['node', 'scripts/maintenance/render-showcase-gaps.js'],
    opts: '[--only <charId1,charId2>] [--concurrency <n>] [--gateway <url>] [--redo-mine]',
    run: { nature: ['external-model', 'writes-product', 'writes-source'], machine: ['gateway', 'node', 'python-pillow'], switches: { '--dry-run': ['preview', 'writes-product'] }, resume: 'checkpoint', evidence: 'scripts/maintenance/render-showcase-gaps.js:60-61,196,199-204', unknown: [], notes: ['缺陷登记（C2，待主任务处理）：--dry-run 仍 mkdir assets/custom-gens/；直写活跃 manifest 无版本化；新条目 verdict 硬编码 pass'] },
  },
  'showcase:audit': {
    required: ['--manifest', '--out'],
    desc: '批量审核 popular showcase (Gemini 4并发，rella)',
    cmd: ['node', 'scripts/maintenance/audit-showcase-rella.js'],
    docs: 'scripts/maintenance/audit-showcase-rella.js:1',
    run: { nature: ['external-model', 'writes-product'], machine: ['vision-api', 'node'], switches: {}, resume: 'checkpoint', evidence: 'scripts/maintenance/audit-showcase-rella.js:44-48', unknown: [] },
  },
  'showcase:audit:scene': {
    required: ['--manifest'],
    desc: '批量审核 scene showcase (Gemini 4并发，scene 版)',
    cmd: ['node', 'scripts/maintenance/audit-scene-showcase-run.js'],
    docs: 'scripts/maintenance/audit-scene-showcase-run.js:1',
    run: { nature: ['external-model', 'writes-product'], machine: ['vision-api', 'node'], switches: {}, resume: 'checkpoint', evidence: 'scripts/maintenance/audit-scene-showcase-run.js:93-113', unknown: [] },
  },
  'showcase:publish': {
    required: ['--from', '--source', '--target'],
    desc: '预览审核通过的样张发布（--apply 写入版本目录）',
    cmd: ['node', 'scripts/maintenance/publish-popular-showcase.js'],
    docs: 'docs/archive/troubleshooting/showcase-generation-craft.md',
    run: { nature: ['preview'], machine: ['node', 'python-pillow'], switches: { '--apply': ['writes-release', 'writes-source'], '--force': ['delete', 'writes-release'] }, resume: 'idempotent', evidence: 'scripts/maintenance/publish-popular-showcase.js:9-12,24-27', unknown: [], notes: ['--apply 除新版本目录外还写仓库内 assets/characters/popular-<id>.png 立绘'] },
  },
  'showcase:batch': {
    desc: '统一批量调度（替代 8 个 run-batch-* 脚本）',
    cmd: ['node', 'scripts/maintenance/run-batch.js'],
    docs: 'scripts/maintenance/run-batch.js:1',
    opts: '--source popular|scenes --batch-size 10 --concurrency 3',
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'node'], switches: { '--dry-run': ['preview'], '--help': ['read-only'] }, resume: 'checkpoint', evidence: 'scripts/maintenance/run-batch.js:35-54,165-166', unknown: ['实际副作用取决于被调度的 generate 脚本'] },
  },
  'showcase:full': {
    desc: '样张链路：generate -> audit -> 发布预览（--output / --source / --target 必填）',
    cmd: null,
    docs: 'docs/archive/troubleshooting/showcase-generation-craft.md',
    steps: ['showcase:generate', 'showcase:audit', 'showcase:publish'],
    run: { nature: ['external-model', 'writes-product'], machine: ['gateway', 'vision-api', 'node', 'python-pillow'], switches: {}, resume: 'checkpoint', evidence: 'scripts/workflow.js:200-205; scripts/lib/workflow-runner.js:37-53', unknown: [], notes: ['复合：生成与审核实际执行，发布步仅预览（--apply 被 plan() 参数白名单拒绝）'] },
  },
  'check:quick': {
    desc: '并行质量门 npm run check（注册项全跑；与 gate:quick 区别：本命令全量并行，gate:quick 按改动面积只跑相关）',
    cmd: ['npm', 'run', 'check'],
    docs: 'AGENTS.md#实施与交付',
    run: { nature: ['read-only', 'self-heal-missing'], machine: ['node'], switches: { '--list': ['read-only'] }, resume: 'na', evidence: 'scripts/maintenance/run-check-parallel.js:22-57', unknown: [], notes: ['22 步全部 --check/validate；例外：fresh clone 产物缺失时 ensureAll 落盘自愈'] },
  },
  'gate:quick': {
    desc: '按改动类型分层门禁（ui|server|data|all；与 check:quick 区别：只跑改动相关面积，更快，缺省自动检测 git 改动）',
    cmd: ['node', 'scripts/maintenance/gate-quick.js'],
    opts: '[ui|server|data|all] [--verbose] [--all]',
    docs: 'docs/workflow.md',
    run: { nature: ['guard', 'self-heal-missing', 'isolated-fixture', 'writes-product'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/gate-quick.js:65-118,174-189', unknown: ['实际范围由 Git 变更或位置参数决定，此处列可能发生的行为'], notes: ['scripts/config 等变更会升级 full 并执行构建；data 面积含三个 --check 构建守卫；纯文档改动跳过'] },
  },
  'gate:full': {
    desc: '全量门禁：typecheck + check + 前端 + unit + contract + 打包预算（横切重构/提交前）',
    cmd: ['node', 'scripts/maintenance/gate-quick.js', 'full'],
    docs: 'docs/workflow.md',
    run: { nature: ['read-only', 'self-heal-missing', 'writes-product'], machine: ['node', 'build-present'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/gate-quick.js:174-189', unknown: [], notes: ['末步真实执行 npm run build（vite+预算+预压）'] },
  },
  'check:full': {
    desc: '完整校验：check + frontend + unit + contract',
    cmd: ['npm', 'run', 'validate'],
    docs: 'AGENTS.md',
    run: { nature: ['read-only', 'self-heal-missing'], machine: ['node'], switches: {}, resume: 'na', evidence: 'package.json scripts.validate', unknown: [], notes: ['不含 build（与 gate:full 的区别）'] },
  },
  'check:content': {
    desc: '仅内容契约 + DATA_VERSION',
    cmd: ['npm', 'run', 'test:content'],
    docs: 'scripts/maintenance/validate-content-contracts.js:1',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'package.json scripts.test:content', unknown: [] },
  },
  'build:web': {
    desc: '前端构建 + 预算 + 预压',
    cmd: ['npm', 'run', 'build'],
    docs: 'AGENTS.md#实施与交付',
    run: { nature: ['writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.build（vite build && check-bundle-budget && precompress）', unknown: [] },
  },
  'build:runtime': {
    desc: '编译 services/*.ts -> .js',
    cmd: ['npm', 'run', 'build:runtime'],
    docs: 'package.json',
    run: { nature: ['writes-product'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'package.json scripts.build:runtime', unknown: [] },
  },
  'deploy:desktop': {
    desc: '桌面增量部署（跳过构建）',
    cmd: ['deploy-desktop.bat', '-SkipBuild'],
    docs: 'docs/desktop-deployment.md',
    run: { nature: ['writes-release', 'service'], machine: ['windows'], switches: {}, resume: 'idempotent', evidence: 'deploy-desktop.bat:17-23; scripts/lib/workflow-runner.js:100-103', unknown: [], notes: ['UAC 需用户操作；runner 仅接受开关参数并强制 Windows'] },
  },
  'deploy:desktop:full': {
    desc: '桌面完整部署（前端构建 + 复制 + 清缓存 + 验证 + 重启）',
    cmd: ['deploy-desktop.bat'],
    docs: 'docs/desktop-deployment.md',
    run: { nature: ['writes-product', 'writes-release', 'service'], machine: ['windows'], switches: {}, resume: 'idempotent', evidence: 'deploy-desktop.bat:7-15', unknown: [] },
  },
  // ── check: 单项门禁（可单独跑或组合）──────────────────────────────
  'check:monolith': {
    desc: '600 行红线只降不升门禁（以 monolith-baseline.json 为准）',
    cmd: ['node', 'scripts/tests/test-monolith-budget.js'],
    docs: 'scripts/tests/test-monolith-budget.js:1',
    opts: '[--update-baseline] 重新生成基线（体量真降后用）',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: { '--update-baseline': ['writes-baseline'] }, resume: 'na', evidence: 'scripts/tests/test-monolith-budget.js:141-147', unknown: [] },
  },
  'check:contrast': {
    desc: '双主题全局与角色强调色对比度门禁（WCAG AA）',
    cmd: ['node', 'scripts/maintenance/check-contrast.js', '--check'],
    docs: 'AGENTS.md#质量红线',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/check-contrast.js:288', unknown: [] },
  },
  'check:animations': {
    desc: 'GPU 合成属性门禁（禁 left/top/width/height 补间）',
    cmd: ['npm', 'run', 'lint:animations', '--', '--check'],
    docs: 'AGENTS.md#质量红线',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/lint-animations.js:207-220', unknown: [] },
  },
  'check:ref-urls': {
    desc: '参考库 URL 断链门禁（按当前索引，pending 不算已发布）',
    cmd: ['node', 'scripts/maintenance/check-ref-urls.js'],
    docs: 'scripts/maintenance/check-ref-urls.js:1',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/check-ref-urls.js:51-61', unknown: [], notes: ['URL 存在性检查与网关共用素材根解析；素材根缺失可用 AICS_REFERENCE_AUDIT_MODE=structure（仅结构，须注明）'] },
  },
  'check:pinned-scenes': {
    desc: '定稿场景字节级保护门禁（100 条手工定稿）',
    cmd: ['node', 'scripts/tests/test-pinned-scene-prompts.js'],
    docs: 'AGENTS.md#质量红线',
    run: { nature: ['read-only', 'guard', 'isolated-fixture'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/tests/test-pinned-scene-prompts.js:17,35-53', unknown: [], notes: ['门禁本体只读；自带测试使用临时夹具'] },
  },
  'check:rewrite': {
    desc: '批量改写完整性门禁（覆盖率/模板签名/跨条目雷同）',
    cmd: ['node', 'scripts/tests/test-prompt-rewrite-integrity.js'],
    docs: 'AGENTS.md#质量红线',
    opts: '[--delivery <交付文件>] 复检指定交付',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/workflow.js:279-284', unknown: ['脚本主体未逐行核实（盘点 code-verified 级）'] },
  },
  'check:popular': {
    desc: '热门角色与提示词契约',
    cmd: ['node', 'scripts/tests/test-popular-content.js'],
    docs: 'scripts/tests/test-popular-content.js:1',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'scripts/tests/test-popular-content.js:933-945', unknown: [] },
  },
  'check:anima-routes': {
    desc: 'Anima 接口与生成边界契约',
    cmd: ['node', 'scripts/tests/test-anima-routes.js'],
    docs: 'scripts/tests/test-anima-routes.js:1',
    run: { nature: ['isolated-fixture'], machine: ['node'], switches: {}, resume: 'idempotent', evidence: 'scripts/tests/test-anima-routes.js:107-119,647-661', unknown: [] },
  },
  'check:frontend': {
    desc: '前端单测（vitest，stores/utils/composables 主战场）',
    cmd: ['npm', 'run', 'test:frontend'],
    docs: 'vitest.config.ts',
    run: { nature: ['isolated-fixture'], machine: ['node'], switches: {}, resume: 'na', evidence: 'package.json scripts.test:frontend', unknown: [] },
  },
  'check:style-debt': {
    desc: '样式债聚合门禁（style-debt + style-literals + contrast + colors + animations）',
    cmd: ['npm', 'run', 'test:style-debt'],
    docs: 'package.json',
    run: { nature: ['read-only', 'guard'], machine: ['node'], switches: {}, resume: 'na', evidence: 'package.json scripts.test:style-debt', unknown: [] },
  },
  'check:bundle': {
    desc: '打包预算门禁（路由与依赖闭包，build:web 隐含）',
    cmd: ['node', 'scripts/maintenance/check-bundle-budget.js'],
    docs: 'AGENTS.md#实施与交付',
    run: { nature: ['read-only', 'guard'], machine: ['node', 'build-present'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/check-bundle-budget.js:198-201', unknown: [] },
  },
  // ── backup / runtime: 磁盘债治理 ────────────────────────────────
  'backup:git': {
    desc: 'git bundle 本地第二副本（v2 增量链：锚点×2 + 增量×10）',
    cmd: ['node', 'scripts/maintenance/git-bundle-backup.js'],
    docs: 'scripts/maintenance/git-bundle-backup.js:1',
    opts: '[--keep N] 增量保留份数（默认 10）',
    run: { nature: ['writes-product', 'delete'], machine: ['node'], switches: {}, resume: 'checkpoint', evidence: 'scripts/maintenance/git-bundle-backup.js:61-129', unknown: [], notes: ['清理超量旧 bundle；不能替代 push/异地副本'] },
  },
  'runtime:clean': {
    desc: '实验孤儿目录清理（dry-run 默认、白名单保护、30 天 mtime 门槛）',
    cmd: ['node', 'scripts/maintenance/clean-runtime-experiments.js'],
    docs: 'scripts/maintenance/clean-runtime-experiments.js:1',
    opts: '[--prune] 真删  [--days N] 改门槛',
    run: { nature: ['read-only'], machine: ['node'], switches: { '--prune': ['delete'] }, resume: 'idempotent', evidence: 'scripts/maintenance/clean-runtime-experiments.js:31-43,121-143', unknown: [], notes: ['--prune 仅删已收编实验目录（KNOWN_EXPERIMENTS/tmp-*）且超 --days（默认 30）；白名单与未识别目录永不删'] },
  },
  'comfy:start': {
    desc: '启动本机 ComfyUI（reference/showcase 链路依赖前置，--disable-smart-memory）',
    cmd: ['powershell', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/maintenance/start-comfyui.ps1'],
    docs: 'scripts/maintenance/start-comfyui.ps1:1',
    needs: 'ComfyUI 已安装且权重就位',
    run: { nature: ['service'], machine: ['windows'], switches: {}, resume: 'na', evidence: 'scripts/maintenance/start-comfyui.ps1:51', unknown: [] },
  },
  // ── test: 套件入口 ────────────────────────────────────────────────
  'test:contract': {
    desc: '契约测试套件（内容/接口/热门/Anima 等聚合）',
    cmd: ['npm', 'run', 'test:contract'],
    docs: 'package.json',
    run: { nature: ['isolated-fixture', 'self-heal-missing'], machine: ['node'], switches: { '--all': ['read-only'], '--verbose': ['read-only'] }, resume: 'na', evidence: 'scripts/tests/quality-test-inventory.js:94-121; scripts/tests/run-quality-suite.js:176', unknown: [] },
  },
  'test:e2e:critical': {
    desc: '关键 e2e 套件：主流程、双主题/设备、角色及办公机回归（用例数以执行结果为准）',
    cmd: ['npm', 'run', 'test:e2e:critical:run'],
    docs: 'package.json',
    needs: 'playwright 浏览器已安装（npx playwright install）',
    run: { nature: ['isolated-fixture'], machine: ['node', 'playwright-browser', 'build-present'], switches: {}, resume: 'na', evidence: 'package.json scripts.test:e2e:critical:run', unknown: [], notes: ['生成链路用模拟上游；浏览器测试期间不得重建共享 dist'] },
  },
  'test:e2e:performance': {
    desc: '独立单 worker 绘图页冷/热进入与首次操作测量',
    cmd: ['npm', 'run', 'test:e2e:performance'],
    docs: 'docs/workflow.md',
    needs: '已完成 build；运行时不要并行构建或执行其他浏览器测试',
    run: { nature: ['isolated-fixture'], machine: ['node', 'playwright-browser', 'build-present'], switches: {}, resume: 'na', evidence: 'playwright.performance.config.ts:7', unknown: [] },
  },
  'audit:orphans': {
    desc: '探测 scripts/maintenance/ 下零引用的孤儿脚本（只读，列清单不删）',
    cmd: ['node', 'scripts/maintenance/detect-orphan-scripts.js'],
    docs: 'scripts/maintenance/detect-orphan-scripts.js:1',
    opts: '[--json] 机器可读输出；[--check] 孤儿候选非零时失败',
    run: { nature: ['read-only'], machine: ['node'], switches: { '--check': ['guard'], '--json': ['read-only'] }, resume: 'na', evidence: 'scripts/maintenance/detect-orphan-scripts.js:90-144', unknown: [] },
  },
  'character:onboard': {
    desc: '一站式新角色接入（档案/标准/粒子/参考图/样张/DATA_VERSION）',
    cmd: ['npm', 'run', 'character:onboard'],
    docs: 'docs/guides/characters/character-onboarding-workflow.md',
    run: { nature: ['writes-source', 'external-model', 'writes-product'], machine: ['gateway', 'node', 'python-pillow'], switches: { '--skip-render': ['writes-source'], '--deploy': ['writes-release'] }, resume: 'checkpoint', evidence: 'scripts/maintenance/workflow-onboard-popular-character.js:23-348', unknown: [], notes: ['--skip-render 跳过出图但不能据此声明资产完成；--deploy 走 deploy-desktop-quick.ps1 -NoRestart'] },
  },
  'audit:coverage': {
    desc: '只读差额报告：热门服装→参考登记、角色→主题选择器覆盖差额（信息性，不作为门禁失败依据）',
    cmd: ['node', 'scripts/maintenance/report-content-coverage.js'],
    opts: '[--json] 机器可读输出；[--root <目录>] 指定隔离夹具根（默认仓库根）',
    docs: 'docs/workflow.md',
    run: { nature: ['read-only'], machine: ['node'], switches: { '--json': ['read-only'] }, resume: 'na', evidence: 'scripts/maintenance/report-content-coverage.js:1', unknown: [], notes: ['结构错误（清单缺文件/重复 ID/批次数不符）退出 1；覆盖差额只报告恒退出 0，不自动登记/补图/改主题'] },
  },
};

const { main } = require('./lib/workflow-runner');
if (require.main === module) process.exitCode = main(process.argv.slice(2), WORKFLOWS, ROOT);
module.exports = { WORKFLOWS };
