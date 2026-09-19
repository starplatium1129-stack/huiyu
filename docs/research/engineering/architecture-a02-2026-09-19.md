# 架构 A02.1：独立保存生成作品用例

对应 [长期架构计划](../../../plans/architecture-evolution.md)；当前剩余任务见 [roadmap](../../roadmap.md)。本批主要责任为保存流程抽取，提交快照时机调整属于 A02.2，尚未实施。

实施始于 2026-09-19，验收记录更新于 2026-09-20。A02.1 已实现并完成定向、分段契约和浏览器验证；完整门禁入口因既有蓝图事务文件的 180 秒时限仍未通过，不登记为 accepted。

## 基线与前置盘点

- 首批 A01.2 / A07.1 已于 `e2c5979f037275786a315ed556655648d794ce41` 提交并推送到 main；原主目录同步到同一提交，保留其他会话的 `assets/live2d-candidates/` 未跟踪内容。
- 本批沿用独立 worktree，基线即上述 main 提交。Windows / Node `v24.18.0` / npm `11.16.0`，复用已安装依赖；不安装、调用真实模型或访问用户图库。
- A01.3 盘点覆盖 `promptHistoryStore → promptBuilderStore → 历史恢复/深链/视频/临时结果`：旧列表是 `ArtworkRecord[]`，新记录是 `HistoryEntry`，恢复视图由 `parseHistoryRecipe` 检查后推导。此前历史数组的跨层双重断言已由主干消除；同一 Store 中场景/词条加载的断言不属于作品模型迁移。
- `resultContext` / `useTempResult` 中剩余 JSON 克隆断言以已有的强类型快照为输入，不把外部未知记录断言成完整生成事实；兼容导出保留唯一定义，不因本批而退役。字符串/数字 ID、父作品、项目与未知字段保持原持久化语义。A01.3 的这条作品链路盘点完成，不代表所有场景或网络边界都已规范化。
- 修改保存实现前新增 8 项中性特征测试并全部通过，日志 `runtime/architecture-a02/baseline-characterization.log`；核心夹具在抽取后复跑。后来补充的 engine/profile/lora 显式断言属于本批新增验收，不冒充迁移前已运行。

## 调用与责任

| 入口 / 模块 | 当前责任 | 保持的边界 |
| --- | --- | --- |
| SD 队列、批量、Anima/Krea 自动保存、临时与手动入册 | 继续调用 `promptBuilderStore.commitHistoryEntry` | 不改变调用时机、现有提交快照或真实生成请求 |
| `resolveLegacyArtworkDefaults`（Store 内） | 在原先测量完成后的节点显式提供身份、标题、项目与参数默认值；提供已有风格正规化函数 | 保留 `??` / undefined 的旧优先级；这仍是兼容默认值，不是新提交快照 |
| `application/artwork/saveGeneratedArtwork` | 合并上下文、暂存保护、写图、缩略图、尺寸、ID、组装记录、Repository 提交、失败补偿 | 无 Store/Vue/Toast/路由/具体数据库导入，依赖均由装配入口提供 |
| Store 外壳 | 在暂存适配中接收完整结果，成功后发布列表；失败记录原错误并返回 null | 历史只在持久化完成后显示，列表更新仍在解除暂存保护前完成 |
| 现有 `artworkRepository` / 图片与历史 Store | 继续拥有真实存储、跨窗口互斥、ID 序号、尺寸回退和派生缩略图 | 数据库名称/版本/键、用户备份格式、锁获取顺序和 ID 算法不变 |

用例返回明确成功记录/列表或原错误，锁失败和上下文克隆异常仍按原语义拒绝。图片写入、启动缩略图、测量和提交的先后顺序保持；UI 列表更新归 Store 的暂存适配，在持久化之后、解除保护之前执行。保护内发布断言在首次抽取实现上复现 1 失败 / 7 通过，调整装配后全部通过；不将这条内部时序回归误报成已证实的用户数据丢失。

字段特征包括：上下文身份覆盖条目身份；显式零值与空数组保留；scene/shot 等字段沿用 undefined 判断、保留显式 null，sceneTitle 等字段继续沿用原 nullish 回退；`model` 仍决定 checkpoint；热门模式清空工作室 LoRA；父 ID 保留字符串或数字；派生缩略图失败不回滚原图；无法读取尺寸仍为 null，不从下拉框伪造。用例不读取当前角色或表单，旧回退由显式兼容适配提供。

## 检查与回归

`check:domain-types` 沿用现有入口并加入新用例：指定类型/纯规则/用例不得经间接路径引用具体存储/API、Store、组件或 Node 文件系统。依赖能力接口定义在用例处，无需拉入具体 Repository 类型；通用 ESLint 的原规则不变。新增反例验证纯模块经中转直连存储或 Node 的绕过会被拒绝。

原 `test-prompt-builder-modules` 在 Store 中查找字段字符串的断言不再适用，替换为实际 AST 装配检查；字段持久化职责由 `promptBuilderHistory.spec.ts` 的真实保存行为断言承接，不删减提示词、分级、角色锚点或其他静态保护。

浏览器新增双页用例通过真实 `saveGeneratedArtwork`、图片存储、IndexedDB 与 Web Locks 提交；测量与默认值是中性夹具，不代表图像解码或模型效果。原 library-concurrency 覆盖暂存、回收、事务失败和跨窗口；office-code 的双主题键盘出图入册走模拟上游和生产应用，补全真实像素解码与页面装配。

## 当次验证

| 检查 | 当前结果 | 本 worktree 日志 |
| --- | --- | --- |
| 抽取前 8 项特征测试 | PASS | `runtime/architecture-a02/baseline-characterization.log` |
| 抽取后定向前端回归 | 52 项通过，含保护内发布及生成元数据断言 | `runtime/architecture-a02/targeted-final.log` |
| 运行时、前端及浏览器测试类型检查 | PASS | `runtime/architecture-a02/runtime.log`、`app-types-final.log`、`e2e-types.log` |
| 依赖与装配检查 | 17 项通过；新增存储/Node 绕过反例生效 | `runtime/architecture-a02/boundaries.log` |
| 完整入口中的质量 / 前端 / Node | 17 项质量检查、986 项前端、1,070 项 Node 通过；另 2 项既有环境跳过 | `runtime/architecture-a02/gate-serial.log` |
| 完整门禁入口 | FAIL：并发模式与串行模式均在同一个既有蓝图事务文件达到 180 秒；未调整时限，未删断言 | `runtime/architecture-a02/gate-verified.log`、`gate-serial.log` |
| 蓝图事务单文件补跑 | 9 / 9 PASS，退出 0，245.94 秒；直接入口没有套件外层时限，不算 full PASS | `runtime/architecture-a02/blueprint-direct.log` |
| 先前未执行的其余契约 | 27 组全部通过；连同完整入口先完成的 6 组和单文件，34 组契约分段完成 | `runtime/architecture-a02/contract-remaining.log` |
| 最终生产构建 | PASS；工作台路由 139.4 KiB / 140 KiB，未提高预算 | `runtime/architecture-a02/verified-build.log` |
| 原生浏览器存储 / 双主题入册 | 19 项全部通过，0 失败 / 跳过 / flaky；45.49 秒 | `runtime/architecture-a02/browser-results.json`、`browser.log` |

完整门禁沿用办公机 structure 模式；浏览器上游、端口、runtime 和用户资料隔离。不将办公机结果升级为真实模型或原生设备验收。首批最终提交与旧证据的绑定为 `runtime/delivery-evidence/architecture-a01-main-finalized.json`。

单文件与剩余契约沿用原断言和真实校验器；相关蓝图事务源码相对本批基线无改动（`blueprint-source-diff.txt` 为空）。两项 Node 跳过仍为文件符号链接环境与缺少 SceneShowcase 实物。浏览器使用端口偏移 18000、独立上下文、单 worker；只替换上游和中性夹具，实际存储/锁及生产页面代码未替换。

执行前快照 `runtime/delivery-evidence/architecture-a02-final-baseline.json` 与结果绑定在 `architecture-a02-office.json`；使用现有 capture:delivery / audit:delivery 格式。source/build 均 fresh，browser 为 passed，fullGate 如实为 failed；审计退出 1，唯一 errors 项是已记录的 fullGate 失败，不宣称总审计通过。安装、真实模型、WebView2/目标硬件继续 not-run。

| 受测身份 | SHA-256 |
| --- | --- |
| 所选源集合 | `b51e86f73e7e73e641329cadc139d01e1fbd77012b80cf03499ad106a4e4b4b7` |
| 完整 dist 集合 | `c64b0cb83af2feff4ba5a1c1b0b52039ed7085647142a7ca16baf125a9c50ab0` |
| dist/index.html | `01bd878d9b45a3bb0b4be5e56d9ca283fc923477d5ed1cc14319f2b28f5cfd70` |

早期浏览器类型导入错误已通过夹具入口修正；暂存时序问题有失败与修复后日志。为修正这些问题中止的运行不计 PASS。最终源码冻结后仅补验和回填文档，提交后通过 finalize 绑定同一源/构建，不将提交或分段补跑伪装成另一次完整门禁通过。

## 尚未改变的行为与回退

A02.2 / A02.3 保持开放：缺字段的旧输入仍在测量后读取兼容默认值，新用例抽出不等于全链已经完全冻结提交事实。现有调用者全部经旧外壳复用同一保存能力，但逐个改成完整显式提交快照尚未实施。

本批保留原有仅针对本次 imageId 的异步失败清理，清理失败不覆盖原始提交错误；没有把它升级为可恢复或恰好一次事务。自定义适配器若“已提交又抛错”，需要独立的提交身份核对设计；本批不增加盲重试、不宣称该模糊结果已解决，也不清理任何其他旧图。

可按本批提交回切用例及 Store 装配，保留已产生的合法作品；不同时运行新旧两套写入，不恢复数据库覆盖用户后续作品。下一批先选择一个生成入口迁移完整提交快照，再扩展其他调用者。
