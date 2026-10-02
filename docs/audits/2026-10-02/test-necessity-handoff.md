# 全部测试必要性审查：暂停与续接

2026-10-02 用户因额度要求立即停止。实现、审查和测试均已停止；本次是未完成工作的检查点，不是全量精简完成声明。

## 已保存与未完成

前两轮已提交 main：`0a8a13ad`、`d11a05e2`。用户随后明确要求逐条核对所有剩余测试；本轮仅完成部分逐项审查，不能说剩余测试全都必要。

| 分工 | 总记录 | 已审 | 未审 |
| --- | ---: | ---: | ---: |
| frontend-state | 983 | 332 | 651 |
| frontend-other | 868 | 356 | 512 |
| node | 1440 | 80 | 1360 |
| browser | 401 | 34 | 367 |

上述是声明、参数家族及大脚本风险组的混合口径，不是实际运行用例数。Rust/Tauri、Python 尚未建立本轮完整逐例必要性台账；上一轮运行通过不能代替此审查。

已审理由、逐文件待审 ID 与原始台账哈希保存在 [检查点](test-necessity-checkpoint.json)。完整测试体/原始断言仍在 `runtime/test-necessity-full-20261002/` 的四份同名 JSON；该目录被忽略，清理或迁移工作区前应另行保存。检查点不包含原始测试体，续接时须重新读取当前源码，不能自动把 pending 变成 keep。

## 本轮落盘改动与验证边界

- 前端：合并重复请求、空态、封面失败、边界输入、历史/缓存装载等路径；删除已不被生产逻辑消费的桌面 mock；补真实隐藏状态的 canAnimate 断言。
- Node：眨眼 reset/长帧钳制原断言存在假保护，已在原例中改为实际半闭状态及时间边界；删除情绪适配的 typeof 字符串空断言和声线基线中的自证 WAV 比较；合并工作流本地 helper 自测，保留真实 registry 的只读约束。
- 浏览器：studio 移除普通回归中的真实 Live2D 加载与固定编辑性数量，保留设备专项；场景隐藏/恢复改核对具体身份；desktop-atelier 的独有行为迁入 atelier-design、expert-workspace、studio，并删除旧文件及登记。
- 仅已有前端第一批 9 文件 / 72 项定向 PASS（见 runtime/test-necessity-full-20261002/frontend-other-batch1.log）。其他本轮改动尚未合批验证，Node 工具生成入口尚待重新 build:runtime；不得沿用 d11a05e2 的 PASS 冒充本轮证据。
- 用户要求停止后只做保存、Git 差异检查及提交推送，不再启动测试。

## 续接顺序

1. 先核对 main、工作区和会话「审计并精简项目代码」的隔离分支。该会话正在退役旧 Node 后端；它的未提交生产改动不属于本检查点，不要覆盖，也不要重建已经迁移/删除的旧测试。
2. 依据检查点与四份本地台账继续逐条读取实际断言及生产入口，明确独有故障和重复覆盖；优先完成已有分工剩余 2890 条记录，再建立 Rust/Tauri/Python 的逐例台账。源码变动、删除和参数族拆合必须重新对账。
3. 先对本轮未验证改动运行必要编译与定向测试：Node build:runtime 与修改的五个脚本测试；前端完整套件/覆盖率；浏览器 studio、atelier-design、expert-workspace 与清单检查。定位失败时修夹具或实现证据，不放宽有效断言，不为测试数量设删除配额。
4. 所有存留记录必须有经实际源码核对的保留依据；未审、迁移待合入、设备未验必须单列。只有未审库存清零且必要验证完成，才可报告全量审查完成。
5. 上轮遗留 InspirationDeck.vue 的内联样式门禁失败仍是生产代码问题，未在本轮处理；不得删除门禁来掩盖。

## 本检查点受控测试文件

- `scripts/tests/test-blink-scheduler.ts`
- `scripts/tests/test-drawing-route.ts`
- `scripts/tests/test-mood-tag.ts`
- `scripts/tests/test-voice-baseline.ts`
- `scripts/tests/test-workflow-runner.ts`
- `src/api/client.spec.ts`
- `src/components/director/DirectorSceneReference.spec.ts`
- `src/components/director/DirectorStagePanel.reveal.spec.ts`
- `src/components/director/OutfitOverrideNotice.spec.ts`
- `src/components/gallery/GalleryProjectAlbums.spec.ts`
- `src/components/showcase/ShowcaseAlbums.spec.ts`
- `src/components/visual/CgImageReveal.spec.ts`
- `src/components/visual/ImageSplitCompare.spec.ts`
- `src/components/visual/aiVisualLifecycle.spec.ts`
- `src/composables/scene/useSceneMaintenance.spec.ts`
- `src/composables/scene/useSceneManagerWorkspace.spec.ts`
- `src/composables/useVisualActivity.spec.ts`
- `src/stores/promptBuilderHistory.spec.ts`
- `src/stores/sceneStore.spec.ts`
- `tests/e2e/atelier-design.spec.ts`
- `tests/e2e/desktop-atelier.spec.ts`
- `tests/e2e/e2e-lanes.json`
- `tests/e2e/expert-workspace.spec.ts`
- `tests/e2e/studio.spec.ts`

## 收口合并补记

推送时远端 main 已包含其他会话的旧 Node 退役与安装包升级，收口时一并合入。原审查库存仍是合并前快照，续接必须先按当前源码重建，已删除的旧测试不要复活。用户要求停止后未执行此次合并的整合测试。共享工作区合并前的未提交副本保存在 Git stash（说明：preserve shared workspace before stop-request merge 2026-10-02）；不要直接整批恢复，以免覆盖远端已经更新的版本，确有独有改动再按文件取回。
