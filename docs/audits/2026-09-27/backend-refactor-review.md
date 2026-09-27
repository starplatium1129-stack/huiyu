# 后端重构必要性复审

审计日期：2026-09-27。审计时后端代码基线 `75072a0d`，HEAD 为 `5d26436e`，后者只包含同期 UI 改动。下文保留修复前的发现与复现；用户同日授权实施，落实结果见末节。没有安装或调用真实模型。

## 结论

**建议局部重构，先处理五个确定的边界缺口。** 当前已有严格 TypeScript、共享 HTTP 客户端、有界队列、持久任务身份、SQLite 单写 Worker、原子发布与维护恢复。早期问题中的一部分已经修复，见[今天的实施记录](backend-audit.md)；本轮以当前代码为准，没有把历史发现重新列为待办。

剩余问题集中在运行时与引擎之间的任务所有权、派生媒体的授权出口，以及持久提交后的文件回收。现有基础可以继续复用。仅按文件长度拆分，或重新建立通用任务/鉴权/存储框架，不能直接消除这些问题。

| 编号 | 优先级 | 审计时的问题 | 修复前隔离证据 |
| --- | --- | --- | --- |
| BR-01 | P1 | 同一分镜任务并发“继续”重复派发同一镜头 | 两个 action 均成功，seed 22 产生两次提交 |
| BR-02 | P1 | 检查点写入失败后，引擎任务与准入名额未释放 | WebUI、Anima 各四次失败后 pending=4，第五次拒绝；WebUI 生成调用为 0 |
| BR-03 | P1 | 内置 Live2D 派生接口绕过远程媒体审核 | 未发布原图 403，模型清单和派生贴图均 200 |
| BR-04 | P2 | 任务暂存清理失败后，GC 遗漏硬链接 | object 已删除，staging 仍保留 68 字节 |
| BR-05 | P2 | 跨站 API 导航取得本机 TTS 权限 | 无 token 的导航形态 GET 返回 WAV，mock 合成调用 1 次 |

上表均有实际隔离运行证据。BR-05 证明 HTTP 接受路径，具体浏览器的本地网络许可与实际触达未验；其他项目也不代表已经测量真实 GPU、生产资料或长期磁盘影响。优先级按任务重复、持续阻塞与现行授权契约评估。

## BR-01：任务级 action 缺少执行所有权

**位置：** [runtime.ts:190](../../../server/tasks/runtime.ts#L190)、[batch-provider.ts:72](../../../server/tasks/batch-provider.ts#L72)、[batch.ts:350](../../../routes/video/batch.ts#L350)。

`resume` 已有 `dispatched/preparing` 防重入，但 `action` 读取任务后直接执行 provider。每次 `continue` 又各自 recover 并创建随机新 batch；`batch.kicking` 只能保护其中一个实例。两个窗口或并发重试可以分别把同一未提交镜头交给引擎，最后写入的 checkpoint 覆盖另一个 batch 身份。

真实 TaskRuntime、BatchProvider、BatchService 和临时 SQLite 配合 fakeVideo：两个并发 action 均 fulfilled，唯一待生成镜头 seed 22 分别产生 `new-shot-1/new-shot-2`；持久 checkpoint 仅保留最后的 batch ID。

**最小修复：** 在 runtime 同步占用 task ID 对应的 action 槽，重复操作共享在途结果或明确拒绝；同一任务 action 与 reconcile 的状态写入有确定顺序。continue 复用核对后的 batch 所有者。不要只在 View 加按钮禁用。

## BR-02：create 与 checkpoint 不在同一个清理范围

**位置：** [providers.ts:77](../../../server/tasks/providers.ts#L77)、[providers.ts:130](../../../server/tasks/providers.ts#L130)、[generation/service.ts:140](../../../server/generation/service.ts#L140)。

Anima/视频 provider 在 `create` 后、进入处理失败的 try 之前等待 `hooks.checkpoint`；WebUI 在占准入名额、登记任务后等待 checkpoint，失败也没有释放。检查点通过 workspace RPC 写入，确实可能拒绝。此时尚未提交上游，持久任务可以失败，内存引擎任务却仍为 queued。

向真实服务注入只在 checkpoint 拒绝的 hook：WebUI 与 Anima 各四次返回检查点写入失败，pending 均为 4，第五次分别返回 `GENERATION_QUEUE_FULL/ANIMA_QUEUE_FULL`。mock WebUI 的 `txt2img` 调用数为 0。视频相同位置的缺口由代码确认，本轮没有另做行为复现。

**最小修复：** 将登记、checkpoint 和提交置于完整的 try/finally 所有权范围，未发生提交意图时回收内存任务与槽位。提交意图已写入、上游应答未知时继续由持久账本核对，不能一律释放或自动重提。WAI Comfy 分支已有相应清理结构，可以参照其实际行为统一这些入口。

## BR-03：派生媒体没有继承源文件的发布资格

**位置：** [live2d.ts:65](../../../routes/live2d.ts#L65)、[live2d.ts:76](../../../routes/live2d.ts#L76)、[remote-content.ts:88](../../../server/remote-content.ts#L88)。

远程静态媒体按本机审核索引和字节哈希放行。两个 Live2D API 对内置 `nene/natsume` 却无条件选用本机 textures，只有其他导入角色才检查本机身份。派生接口位于 `/api`，不经过静态媒体命名空间的审核判定。

用临时 8×8 中性贴图、无发布索引、有效共享 token 与转发头请求：`/assets/live2d-current/nene/texture.png` 返回 403；`/api/live2d-model/nene/standard` 返回 200；`/api/live2d-texture/nene/standard/0.webp` 返回 200 image/webp。贴图替换也不要求重新审核。

**最小修复：** 当前先让两个派生 API 统一执行本机身份门控。需要远程 Live2D 时，再让派生结果绑定已审核源文件身份，并一起核对相关模型资源。无需为此新增通用授权框架。

## BR-04：已提交任务 staging 不属于 GC 识别的 operations

**位置：** [tasks.ts:132](../../../server/workspace/tasks.ts#L132)、[media.ts:118](../../../server/workspace/media.ts#L118)、[garbage.ts:63](../../../server/workspace/garbage.ts#L63)。

正常 COMMIT 后的 staging 清理已经修复。清理失败不会回滚已确认事实，这个顺序是合理的；但 GC 仅识别 `operations` 的 committed/aborted key。任务输入/输出使用自身派生 key，没有相应 operations 行，所以遗留暂存目录一直被跳过。硬链接保留实际文件字节，即使主对象路径已经删除。

只对目标 staging unlink 注入 EBUSY，真实 SQLite 提交成功；丢弃结果并把文件时间移到 30 天保留期之前，再 GC：`gcRemoved=1`、`objectExists=false`、`stagingExists=true`。COMMIT 后、cleanup 前进程退出也存在同一代码路径，该退出窗口本轮未另外注入。

**最小修复：** GC 增加已提交 `task_outputs/task_inputs` 的 staging 身份判定，继续检查 lease、路径与保留期。保留提交后清理的顺序，不把删除失败重新解释为持久化失败。

## BR-05：页面导航例外也放行了生成 API

**位置：** [security.ts:49](../../../server/security.ts#L49)、[voice.ts:238](../../../routes/voice.ts#L238)。

`hasLocalBrowserOrigin` 允许无 Origin 的 cross-site GET/HEAD navigate，以支持从外站打开本机页面。这个例外没有限制目标；`GET /api/tts` 可发起合成，tokenAuth 和 rateLimit 同时把它当本机请求放行。

原生 HTTP 发送正常导航形态的 Sec-Fetch-Site/Mode/Dest，无 token：返回 200 WAV，mock TTS 收到 1 次合成。没有验证真实浏览器的本地网络许可，不能把本次结果表述为已经完成浏览器攻击。

**最小修复：** 跨站导航例外只作用于页面入口，API 不因此取得本机身份；保持同源 audio GET 播放路径。

## 重构顺序与边界

1. **先修任务衔接。** BR-01/02 在 runtime/provider 边界收口执行所有权、checkpoint 失败清理和准入释放。保持已接受任务的持久身份与未知提交处理；各引擎仍保留自身协议语义。
2. **修授权遗漏。** BR-03/05 补齐派生资源出口与页面/API 的身份区分。复用现有 security 和远程发布契约。
3. **补提交后回收。** BR-04 按已提交事实识别遗留 staging，复用 SQLite 与现有 GC。
4. **在修改相关模块时做结构整理。** `routes/anima/service.ts` 当前有效 487 行、`routes/video/batch.ts` 455 行；后者广泛使用 any。优先明确 Batch/Shot 类型，并将实际重复的生命周期职责移入 server 层。服务实现当前位于 routes 子目录且被 runtime provider 反向引用，职责命名值得整理；单纯搬文件不计为漏洞修复。

当前扫描 server.ts/server/routes/services 共 163 个 TypeScript 实现文件、约 2.15 万物理行，生成 JS 与声明文件不重复计数。单体门禁当次通过，0 个基线豁免。SQLite 单写、现有 HTTP 客户端、队列与类型契约继续使用；本轮没有发现需要更换数据库或引入新框架的证据。

## 测试应保留什么、精简什么

- 保留真实行为：任务幂等/重复派发、取消与结果所有权、事务恢复、提交前后边界、远程授权与路径约束。这些对应已发生或本轮复现的问题。
- 修复时每类缺口保留一个针对复现的回归，优先补进现有 task/generation/Live2D/security/storage 夹具。同一入口的非法字段、错误码、取消时机不扩成排列组合。
- 优先精简 [test-chat.ts:254](../../../scripts/tests/test-chat.ts#L254) 的混合源码哨兵：296–451 行包含 56 条 assert，主要检查组件名、方法名、源码片段与 CSS 字面值。文件同时承担前端、Live2D、语音及真实聊天 HTTP 验证，正常重命名容易迫使测试随实现修改。将关键行为交给已有组件/服务测试验证后，可删除重复的字符串检查；保留后面的真实请求、流和权限行为。
- [test-security.ts](../../../scripts/tests/test-security.ts) 的函数对象身份检查、[test-live2d-route.ts](../../../scripts/tests/test-live2d-route.ts) 的 stub 原样透传检查可以在实际 HTTP 装配行为已有覆盖时精简。
- 不因断言多而删除持久化的真实进程退出恢复：这些测试覆盖不同提交边界。也不为这次只读审计跑完整前端/设备/全库门禁。

**审计阶段没有新增正式测试，也没有删除现有测试。** 四份一次性复现留在被忽略的 scripts/archive，不进入长期门禁；实施阶段仅按下节精简或补充既有行为验证。

## 当次验证

环境：Windows、Node v24.18.0。主会话独立运行全部复现，结果与审计会话相同。

| 执行 | 当次结果 |
| --- | --- |
| `npm run build:runtime` | services/node/tests/browser 产物均 current，核对所执行 JS 对应当前源码 |
| `node scripts/archive/backend-refactor-probe-20260927.cjs` | BR-02 WebUI 与 Anima 槽位泄漏复现，上游生成调用 0 |
| `node scripts/archive/backend-audit-batch-action-race.cjs` | BR-01 同一镜头两次提交复现 |
| `node scripts/archive/backend-audit-task-staging-gc.cjs` | BR-04 遗留 staging 复现 |
| `node scripts/archive/backend-security-audit-repro.cjs` | BR-03、BR-05 HTTP 复现 |
| `node --test scripts/tests/test-security.js scripts/tests/test-gateway-contract.js scripts/tests/test-remote-content.js` | 审计会话运行，24/24 通过；现有通过项未覆盖此次派生接口缺口 |
| `node --test scripts/tests/test-task-runtime.js scripts/tests/test-workspace-storage.js scripts/tests/test-workspace-backup.js` | 审计会话运行，19/19 Node 测试通过；存储文件另有 77 项内部检查；未覆盖此次 action/遗留 staging 复现 |
| `node scripts/tests/test-monolith-budget.js` | 主会话运行，通过；1168 个文件，0 个基线豁免 |
| `npm run wf -- docs:check` | 237 份文档、1838 个本地链接、70 个重定向，0 失效链接 |
| `git diff --check` | 通过 |

审计阶段复现使用专属临时目录、临时 SQLite、中性哨兵字节、动态 loopback 端口、mock upstream/fakeVideo；没有生产写入、真实模型、ffmpeg、安装或正式桌面操作。审计阶段没有执行全量门禁或真实浏览器网络许可验收。

## 五项落实（同日）

用户要求完成并提交后，直接实施上述五项；没有新增依赖、schema 迁移或通用任务框架。

| 编号 | 落实行为 |
| --- | --- |
| BR-01 | task ID 同步持有 action 槽，同身份同操作共享在途 Promise；action/reconcile 按任务排序。continue 复用已核对 live batch，首次提交纳入 action 生命周期；外来 principal 无法读取共享结果。取消先落账，及时中止 action 拥有的工作，再核对终态。 |
| BR-02 | Anima/视频的 create→checkpoint→submit 放入完整失败清理范围，提交意图前失败直接删除注册任务。WebUI 检查点失败删除登记并释放准入；WAI Comfy 同步清理未提交登记，未知上游应答继续由持久账本处理。 |
| BR-03 | 两个 Live2D 派生端点统一执行 localOnly，原图、派生清单和贴图均拒绝未经授权的远程读取；本机请求仍可正常读取。 |
| BR-04 | 输入、输出 producer 与 GC 共用原有 staging key 规则。GC 在写事务内批取已提交任务身份及 lease，按 alias、路径与保留期回收遗留硬链接，保留未提交 lease 和已引用原图。 |
| BR-05 | 跨站导航例外限制为已知 SPA 页面路径；用 originalUrl 保留挂载前身份，API 不取得本机免认证能力。同源 audio GET 继续正常合成。 |

### 验证精简

- 分镜旧单条服务回归升级为真实 SQLite/runtime/provider/batch 的代表场景，验证操作去重、查询顺序、原身份保持与取消；没有增加测试排列。
- 生成既有 HTTP 夹具补一组检查点失败回收，覆盖 WebUI/Anima/视频三条实际入口，并确认上游零提交及后续健康请求可完成。
- Live2D 的 stub 透传块换成中性贴图的实际 HTTP 门控；跨站 TTS 仅新增一条页面允许、API 拒绝、同源音频正常的行为回归。原导入回归同步使用统一门控的 403。
- GC 既有单夹具补一个 EBUSY 后提交、近期保留、过期回收场景，同时核对未提交 lease 与原图仍在。
- 删除聊天测试约 200 行混合前端/Live2D 源码哨兵和安全测试的函数对象身份断言；推理参数的两条源码正则改为真实 mock 上游 payload 断言。真实聊天 HTTP、流、权限、队列及现有持久化退出恢复继续验证。

### 实施验证与剩余条件

修复后的四份隔离复现显示：同镜头仅提交一次；WebUI/Anima 连续检查点失败后 pending 保持 0、第五次不再因队列满拒绝；遗留 staging 已删除；Live2D 三个远程请求全 403；跨站 TTS 401 且上游零调用。

| 当次执行 | 结果与范围 |
| --- | --- |
| 最终 `npm run build:runtime` | 严格 TypeScript 与产物生成通过；包含最终取消、缓存释放及导入 HTTP 状态修正 |
| `node --test` 定向生成/聊天 | 5/5 通过，含检查点失败清理及真实上游推理参数 |
| `npm run wf -- gate:full --all` | 实际运行 5m57s，整体失败；前端 Vitest、38 个后端契约文件及生产构建/打包预算通过；质量编排与 unit 首轮失败见下文 |
| `node scripts/tests/run-quality-suite.js check --all` | 完成所有 check 文件，18 通过、2 失败；初轮换行卫生失败已复验通过；其余边界、单体、类型构建、生成产物等通过 |
| 最终 `node --test scripts/tests/test-task-runtime.js scripts/tests/test-generation-routes.js scripts/tests/test-live2d-imports.js scripts/tests/test-desktop-workspace-host.js` | 24/24 通过，覆盖最终 action/取消/排空、checkpoint 失败及统一 403；复用未变的其他契约通过证据 |
| 受控 TypeScript 文件 ESLint | 0 错误，233 条类型 any 告警保留；没有扩大为全后端类型改写 |
| 最终单体预算、文档链接、diff 空白检查 | 通过；1169 个受扫文件、0 豁免；237 份文档、1838 个本地链接、0 失效链接 |

完整门禁的失败按实际发生顺序保留：

1. 初次 check 因两个工作区 UI CSS 文件含 CRLF 停止 check 套件，其余 19 文件未跑。只将换行归一为 LF，没有改样式值；随后完整 check 套件的卫生检查通过。
2. `content-contracts/ref-urls` 因参考素材根未配置，2534 个登记 URL 无实物验证而失败。没有生成占位图、改写索引、降级 pending 或放宽门禁。
3. 补跑 check 时，E2E 分组缺少 `focus-controls/result-shelf/search-focus/showcase-scroll/ui-finish` 五个既有 spec；native title 为 36、基线 35。两项不属于本次后端修复，保持报告失败，没有改基线或删断言。
4. 初次 unit 为 1169 通过、1 失败、4 跳过；唯一失败是本次 Live2D 统一门控后返回 403，而旧导入夹具期待 404。已更新该权限状态并定向复验通过；没有将初轮失败重标为全量通过。
5. 完整门禁之后收紧 action 的即时取消与关闭排空，只重跑受影响的最终严格构建、四个行为文件、Lint 和单体检查，复用不受影响的其余证据。

详细当次日志保留在被忽略的 `runtime/backend-refactor-fixes-2026-09-27/`：`gate-full.log`、`check-suite.log`、`final-targeted.log`、`final-lint.log`。五项缺口的源码与必要行为验收完成；整体门禁仍有上述素材与 UI/CI 条件，不能表述为全量绿灯。未安装桌面版本、调用真实模型或复验浏览器本地网络许可。
