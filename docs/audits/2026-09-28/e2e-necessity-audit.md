# E2E 必要性审计（2026-09-28）

## 范围与结论

审计本轮开始时全部 **101 个测试文件**（98 个回归文件、3 个性能基准文件），对 **432 处 test 声明及参数组**逐项判断。基线为上一轮精简后的 913 个默认配置展开项。台账与 AST 标题核对无遗漏，额外列出 helper 注册的故障场景；本报告列文件汇总，完整逐声明理由、参数范围和覆盖证据在被忽略的 `runtime/e2e-necessity-audit/{a,b,c,root,decisions}.json`。

保留标准：能指出具体用户故障；没有等价且更便宜的现有覆盖；需要真实浏览器的布局、焦点、原生文件/存储/权限、实际像素或跨页面生命周期。删除仅固定 CSS 类名/旧像素值/目录数量的实现检查、无断言截图、夹具自证和重复页面巡游；非视觉数据/状态检查不乘主题。AA、实际几何、不同布局分支、存储并发、取消、分级和凭据边界不按数量指标删减。

| 入口/库存 | 本轮之前 | 本轮之后 |
| --- | ---: | ---: |
| 默认/PR critical | 225 项 / 17 文件 | 95 项 / 8 文件 |
| nightly 扩展回归 | 465 | 409 |
| 自动全量 critical + nightly | 690 | 504 |
| manual 专项 | 167 | 99 |
| device/资产专项 | 56 | 43 |
| 默认 Playwright 全部发现 | 913 | 646 |
| 独立性能入口 | 14 | 9 |

本轮从默认发现中减少 **267 项（29.2%）**，critical 减少 **130 项（57.8%）**。其中 1 项首页性能预算移入独立基准，5 项实际模型/桌宠资产检查移出 critical；不能把这些转移称为删除。移除全局 desktop-narrow 项目，因为其所有无障碍用例在 1280 与 1440 同一桌面布局分支重复；窄窗口和分屏保留在有实际布局差异的专门用例中。固定启动等待改为已存在的 actionability/expect.poll，不降低超时、错误断言或对比度阈值。没有以用例数下降推算耗时百分比。

## 每次小改动怎么验

- 纯文档：链接/结构核对，不运行 E2E。
- composable/工具逻辑：先定向 `npx vitest run src/.../xxx.spec.ts`。只有跨层绑定或浏览器独有风险再补 E2E。
- 局部样式/交互：复用对应当前构建，运行 `npx playwright test tests/e2e/<相关文件>.spec.ts --project desktop --workers 1`，可用 `--grep`进一步选择场景。颜色/布局保留双主题；纯数据逻辑不再重复主题。
- 生成、持久化、共享导航/权限等核心整合变更或提交门禁：`npm run test:e2e:critical:run`。`npm run test:e2e`仍会先构建，不能把它当作所有局部编辑的必跑命令。
- 只有明确需要完整浏览器回归时使用 `npm run test:e2e:all`（504 项，已有构建）；不使用裸 `playwright test`触发 manual/device。
- 模型、原生窗口、GPU、DPI 和性能基准按变更与设备条件运行；`test:e2e:performance`现在包含原有首页网络/DOM预算，保留基准的采样数。

同一构建已通过的无关检查复用证据，不因提交、测试删减或文档更新再跑一遍全量。应用源文件变化仍需对应的新构建，不能把旧 dist 结果视为源文件验收。本轮运行复用 2026-09-28 18:57:13 的既有 dist，未重建、安装、发布或调用真实生成模型。

## 真实失败保留

核心95项已执行：首次84通过、6失败、5未运行；旧布局常量与折叠菜单入口修正后定向通过2项，余下5项补跑4通过1失败，最终 **90通过、5失败**。重复复验的生成/tooltip不重复计数。以下失败不是冗余，不删断言、不标skip、不下调门槛：

| 失败 | 根因证据 | 保留位置 |
| --- | --- | --- |
| OOM 没有分类为显存不足 | `runtime-rs/src/generation/transport.rs` 的 json() 在非2xx时丢弃上游JSON详情，返回通用错误 | `flows.spec.ts` flow1b |
| TTS 缺参考音频原因丢失 | `runtime-rs/src/voice/speech.rs` 失败分支没有读取响应体 | `flows.spec.ts` flow2b |
| 麦克风/Live2D尾斜杠策略（3项） | `runtime-rs/src/security.rs` 按原始路径精确匹配，SPA仍接受 /chat/；前端 `src/router/documentPolicy.ts`会规范化尾斜杠，双方不一致 | `office-code.spec.ts` microphone及两种storageBlocked |

本轮只精简与校正测试，不改产品错误协议或权限策略。浏览器通过项不代表这三类产品问题已经解决。

## 验证

- E2E TypeScript、分组契约、critical/nightly/all发现、独立性能发现与差异检查。
- 引用的9组较低层测试实际复验：107项通过（tooltip/result tools、route transition/navigation feedback、scene maintenance/workspace/change diff、Live2D映射与控制器）。Live2D低层测试不替代真实眨眼像素/完整启动动作验收；删除的是只看data属性的薄弱重复探针。
- A组合并验证9项通过（画廊比例/键盘、人物资料、控制布局）；B组合并验证7项通过（延迟导航、路由缓存/滚动、角色切换/减少动态、文档AA）。旧选择器失败与定向复验报告都保留。
- C组合并验证44项及1项对比度辅助函数校准通过。修正了旧桌面只读假设、缺字段的视频夹具、旧镜头按钮定位与浅色文字对比度计算分支；AA仍为4.5，实际浅色保守比值14.579:1。未运行全部646项、真实模型设备专项或性能采样。本轮没有新的移动端验收。
- 原始发现、前后源快照、报告、失败追踪和各组逐项理由保留在 `runtime/e2e-necessity-audit/`；本报告是可入库汇总。

## 逐文件结果

数字为默认配置参数展开项；仅保留不同风险的参数分支。`device`包含需要指定资产的浏览器模型专项，不意味着浏览器能够证明原生设备/DPI表现。原始文件的新落点：studio模型用例→`studio-live2d.spec.ts`，首页预算→`home-performance.bench.ts`。测试引用列用于定位低层/其他保留覆盖，不表示每项都可完全替代本文件。

| 原始文件 | 原 → 现 | 当前入口 | 逐项决定 | 覆盖/关联证据 |
| --- | ---: | --- | --- | --- |
| a11y-device.spec.ts | 28 → 5 | critical | 缩减、合并、保留、删除 | `src/components/AppLayout.vue`；`tests/e2e/theme-audit.spec.ts`；`tests/e2e/director-u2.spec.ts` |
| anchored-surface-motion.spec.ts | 4 → 2 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| anima-quick.spec.ts | 20 → 17 | critical | 删除、保留、合并 | `tests/e2e/flows.spec.ts` |
| apple-hig-accessibility.spec.ts | 8 → 7 | nightly | 缩减、保留 | 本文件独有的浏览器行为，详见逐项台账 |
| archive-route-transition.spec.ts | 11 → 6 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| archive-visual-language.spec.ts | 6 → 3 | manual | 删除、保留、缩减 | `tests/e2e/theme-audit.spec.ts`；`tests/e2e/a11y-device.spec.ts`；`tests/e2e/archive-route-transition.spec.ts` |
| artbook-completion.spec.ts | 8 → 8 | nightly | 保留、缩减 | `tests/e2e/theme-audit.spec.ts` |
| artbook-polish.spec.ts | 9 → 9 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| atelier-design.spec.ts | 8 → 7 | manual | 保留、删除 | `tests/e2e/a11y-device.spec.ts`；`tests/e2e/navigation-popover.spec.ts` |
| audit-regressions.spec.ts | 2 → 2 | manual | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| capture.spec.ts | 40 → 0 | 已删除 | 删除 | `tests/e2e/theme-audit.spec.ts`；`tests/e2e/desktop-aesthetics.spec.ts` |
| character-detail-recovery.spec.ts | 10 → 5 | nightly | 缩减 | `tests/e2e/image-fallback-visual.spec.ts` |
| character-editorial.spec.ts | 4 → 2 | manual | 保留、合并 | 本文件独有的浏览器行为，详见逐项台账 |
| character-particle-stage.spec.ts | 8 → 8 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| character-portrait-grouping.spec.ts | 2 → 2 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| character-reference-loading.spec.ts | 2 → 1 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| character-theme-completion.spec.ts | 18 → 17 | manual | 保留、删除 | `src/utils/characterTheme.spec.ts` |
| chat-archive-concurrency.spec.ts | 3 → 3 | critical | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| companion-focus.spec.ts | 21 → 19 | nightly | 保留、缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| companion-frameless.spec.ts | 25 → 24 | nightly | 删除、保留 | `desktop-tauri/src-tauri/src/main_shared.rs` |
| compare-snapshot-lifecycle.spec.ts | 1 → 1 | manual | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| control-layout.spec.ts | 7 → 7 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| creative-library-desktop.spec.ts | 10 → 8 | nightly | 保留、缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| data-boundaries.spec.ts | 6 → 4 | critical | 缩减、保留 | 本文件独有的浏览器行为，详见逐项台账 |
| deferred-search.spec.ts | 3 → 3 | manual | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| desktop-aesthetics.spec.ts | 17 → 16 | nightly | 保留、缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| desktop-atelier.spec.ts | 8 → 5 | device | 缩减、保留 | 本文件独有的浏览器行为，详见逐项台账 |
| desktop-image-origin.spec.ts | 4 → 2 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| desktop-maintenance-runtime.spec.ts | 2 → 2 | manual | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| desktop-personalization.spec.ts | 3 → 3 | device | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| desktop-ux.spec.ts | 9 → 9 | device | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| desktop-workspace-layout.spec.ts | 28 → 14 | device | 缩减、保留 | `tests/e2e/desktop-aesthetics.spec.ts` |
| detail-polish.spec.ts | 8 → 6 | manual | 缩减、保留 | 本文件独有的浏览器行为，详见逐项台账 |
| director-u2.spec.ts | 2 → 2 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| experience-polish.spec.ts | 9 → 9 | manual | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| expert-workspace.spec.ts | 3 → 3 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| flows.spec.ts | 30 → 28 | critical | 保留、缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| fluid-complete.spec.ts | 6 → 3 | manual | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| fluid-dialog-scroll.spec.ts | 4 → 2 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| fluid-glass-async.spec.ts | 2 → 2 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| fluid-ui.spec.ts | 10 → 5 | manual | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| focus-controls.spec.ts | 3 → 3 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| franchise-labels.spec.ts | 2 → 2 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| gallery-layout.spec.ts | 8 → 6 | nightly | 缩减、合并、保留 | `runtime/e2e-necessity-audit/before/studio.spec.ts` |
| github-reference.spec.ts | 6 → 3 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| glass-material-modes.spec.ts | 5 → 5 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| glass-u4.spec.ts | 12 → 12 | manual | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| home-creation-guide.spec.ts | 2 → 2 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| home-hero-maintenance.spec.ts | 11 → 11 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| home-image-recovery.spec.ts | 8 → 4 | nightly | 缩减 | `tests/e2e/image-fallback-visual.spec.ts` |
| illustration-recovery.spec.ts | 8 → 5 | nightly | 缩减、保留 | 本文件独有的浏览器行为，详见逐项台账 |
| image-fallback-visual.spec.ts | 4 → 4 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| interaction-polish.spec.ts | 33 → 19 | nightly | 缩减、保留、删除 | `tests/e2e/theme-audit.spec.ts`；`tests/e2e/navigation-fluidity.spec.ts`；`tests/e2e/a11y-device.spec.ts` |
| layout-unification.spec.ts | 12 → 12 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| library-concurrency.spec.ts | 15 → 15 | critical | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| liquid-glass-polish.spec.ts | 6 → 6 | nightly | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| live2d-imports.spec.ts | 4 → 3 | device | 缩减、保留 | 本文件独有的浏览器行为，详见逐项台账 |
| live2d-performance.spec.ts | 4 → 4 | device | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| model-studio.spec.ts | 5 → 4 | nightly | 缩减、保留 | `src/composables/useModelStudio.spec.ts`；`src/live2d/modelCalibration.spec.ts`；`src/live2d/modelPreview.spec.ts` |
| navigation-fluidity.spec.ts | 20 → 12 | nightly | 删除、保留、合并、缩减 | `src/composables/useNavigationFeedback.spec.ts`；`src/composables/useRouteTransitionCache.spec.ts`；`src/composables/useRouteTransition.spec.ts` |
| navigation-popover.spec.ts | 8 → 4 | nightly | 缩减、保留 | 本文件独有的浏览器行为，详见逐项台账 |
| office-code.spec.ts | 7 → 7 | critical | 保留 | `src/router/documentPolicy.spec.ts`；`tests/e2e/flows.spec.ts` |
| office-performance.bench.ts | 独立基准 | 独立基准 | 保留 | `playwright.performance.config.ts` |
| page-experience-docs.spec.ts | 7 → 6 | nightly | 合并、保留、删除 | `scripts/tests/test-page-architecture.ts`；`tests/e2e/theme-audit.spec.ts`；`src/assets/css/design-system.css` |
| page-experience-flows.spec.ts | 6 → 3 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| page-experience-workspaces.spec.ts | 15 → 6 | nightly | 缩减、保留 | `tests/e2e/creative-library-desktop.spec.ts`；`src/views/PromptBuilderView.vue`；`src/utils/runtimeEnvironment.ts` |
| particle-atmosphere.spec.ts | 2 → 1 | nightly | 合并 | 本文件独有的浏览器行为，详见逐项台账 |
| particle-gpu.spec.ts | 7 → 4 | nightly | 缩减、保留 | `src/utils/particleGpu.spec.ts` |
| particle-narrative.spec.ts | 5 → 3 | nightly | 保留、删除 | `src/components/visual/RouteAtmosphere.spec.ts`；`tests/e2e/director-u2.spec.ts`；`tests/e2e/studio.spec.ts` |
| particle-render-cache.spec.ts | 6 → 6 | nightly | 保留 | `src/utils/particleSnapshot.ts`；`src/utils/particleBody.ts` |
| portrait-room-layout.spec.ts | 4 → 4 | nightly | 保留 | `src/views/CharacterView.vue`；`src/composables/useLive2D-lifecycle.spec.ts` |
| random-inspiration.spec.ts | 4 → 2 | nightly | 缩减 | `src/composables/useRandomInspiration.spec.ts` |
| reka-switch.spec.ts | 4 → 2 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| resource-library.spec.ts | 2 → 1 | nightly | 缩减 | `src/composables/useResourceLibrary.spec.ts`；`scripts/tests/test-resource-install-recovery.ts` |
| resource-recovery.spec.ts | 8 → 4 | nightly | 缩减 | 本文件独有的浏览器行为，详见逐项台账 |
| result-shelf.spec.ts | 2 → 2 | nightly | 保留 | `src/composables/prompt/useResultShelf.spec.ts`；`src/components/director/DirectorResultShelf.spec.ts` |
| room-editorial.spec.ts | 4 → 4 | manual | 缩减、保留 | `tests/e2e/room-experience.spec.ts`；`tests/e2e/live2d-imports.spec.ts` |
| room-experience.spec.ts | 8 → 5 | nightly | 缩减、保留 | `tests/e2e/room-editorial.spec.ts` |
| route-motion-coverage.spec.ts | 9 → 1 | nightly | 缩减、删除 | `src/composables/useRouteTransition.spec.ts`；`src/composables/useRouteTransitionCache.spec.ts`；`tests/e2e/navigation-fluidity.spec.ts` |
| scene-browse-artbook.spec.ts | 2 → 0 | 已删除 | 合并 | `tests/e2e/theme-audit.spec.ts` |
| scene-change-set.spec.ts | 12 → 11 | nightly | 保留、删除、合并 | `src/components/maintenance/SceneImpactPreview.spec.ts`；`src/composables/scene/useSceneMaintenance.spec.ts`；`src/utils/sceneChanges.spec.ts` |
| scene-maintenance-workspace.spec.ts | 9 → 6 | nightly | 合并、保留、删除 | `src/composables/scene/useSceneEditorModal.spec.ts`；`tests/e2e/scene-change-set.spec.ts`；`src/composables/scene/useMaintenanceCatalog.spec.ts` |
| scene-scroll-profiles.spec.ts | 8 → 3 | nightly | 缩减 | `tests/e2e/theme-audit.spec.ts`；`scripts/tests/test-character-profiles.ts` |
| search-focus.spec.ts | 2 → 2 | nightly | 保留 | `src/components/ui/StudioSearch.spec.ts` |
| showcase-image-layout.spec.ts | 12 → 12 | nightly | 保留 | `src/components/showcase/ShowcaseSampleCard.spec.ts` |
| showcase-scroll.spec.ts | 12 → 7 | nightly | 保留、缩减 | `src/composables/useFluidDialog.spec.ts`；`tests/e2e/showcase-image-layout.spec.ts` |
| storyboard-artbook.spec.ts | 3 → 3 | nightly | 合并、保留 | `src/components/video/useShotFirstFrames.spec.ts` |
| studio-primitives.spec.ts | 6 → 6 | nightly | 保留 | `src/components/ui/StudioSelect.spec.ts` |
| studio-tabs-tools.spec.ts | 2 → 2 | nightly | 保留 | `src/composables/useFluidDialogU3.spec.ts` |
| studio.spec.ts | 31 → 16 | critical | 合并、缩减、保留、删除、移出常规 | `tests/e2e/theme-audit.spec.ts`；`tests/e2e/studio-live2d.spec.ts`；`tests/e2e/desktop-workspace-layout.spec.ts` |
| theme-audit.spec.ts | 56 → 36 | nightly | 合并、保留 | `scripts/maintenance/check-contrast.ts`；`runtime/e2e-necessity-audit/before/a11y-device.spec.ts`；`runtime/e2e-necessity-audit/before/scene-browse-artbook.spec.ts` |
| theme-workspaces.spec.ts | 7 → 6 | nightly | 保留、合并 | `src/composables/useTheme.spec.ts`；`tests/e2e/storyboard-artbook.spec.ts` |
| ui-finish.spec.ts | 2 → 2 | manual | 保留 | 本文件独有的浏览器行为，详见逐项台账 |
| ui-fluidity-office.bench.ts | 独立基准 | 独立基准 | 缩减 | `tests/e2e/ui-fluidity.bench.ts` |
| ui-fluidity.bench.ts | 独立基准 | 独立基准 | 保留 | `src/utils/uiFluidityMeasurement.ts`；`tests/e2e/ui-fluidity-office.bench.ts` |
| ui-fluidity.spec.ts | 20 → 10 | manual | 合并、缩减 | `src/composables/useFluidDialog.spec.ts`；`src/composables/useTheme.spec.ts`；`tests/e2e/theme-workspaces.spec.ts` |
| ui-layout.spec.ts | 19 → 19 | nightly | 保留 | `tests/e2e/helpers/contrast.ts`；`tests/e2e/helpers/ui-fluidity-office.ts`；`scripts/maintenance/check-contrast.ts` |
| video-artbook.spec.ts | 9 → 9 | nightly | 保留 | `src/components/video/useVideoFrames.spec.ts`；`src/composables/video/useVideoWorkspace.spec.ts`；`src/api/videoApiResponse.spec.ts` |
| workbench-editorial.spec.ts | 6 → 5 | manual | 保留、缩减 | `src/application/artwork/saveGeneratedArtwork.spec.ts` |
| workbench-loading.spec.ts | 4 → 2 | nightly | 缩减 | `tests/e2e/workbench-editorial.spec.ts`；`tests/e2e/studio-primitives.spec.ts` |
| workbench-polish.spec.ts | 6 → 6 | manual | 保留 | `scripts/maintenance/check-contrast.ts` |
