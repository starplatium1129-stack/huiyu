# Durable Task Runtime 实施规范

> 设计规范，尚未接入生产。对应新版 R5–R7。前置：workspace 写入、权限和恢复协议已通过隔离测试；入口：[总计划](REFACTOR-EXECUTION-PLAN.md)。

## 1. 产品语义先固定

页面退出 = 解除订阅并释放页面资源，不取消已经接受的生成任务。显式取消 = 持久取消意图并执行对应 provider 的取消协议。隐藏窗口与显式退出应用不同，不把退出应用描述为 GPU 作业能够无条件继续。

可靠结果收件箱与作品册是两件事。保留当前自动入册默认关闭；成功生成的字节先在运行时可靠保存为未入册结果，用户保存或既有自动保存设置明确开启时才创建作品。

这不是仅删除 `onUnmounted(cancel)`：必须先让运行时拥有结果采集、清理和状态恢复，否则切页只会制造无人取回的结果。

## 2. 数据模型

任务记录最低字段：

```text
taskId, workspaceId/principalId, requestKey, requestFingerprint
kind, provider, providerFingerprint, upstreamId
status, recoveryState, revision, createdAt, updatedAt
submissionIntentAt, submissionObservedAt, cancelRequestedAt
upstreamSettled, executionDeadline, inputRef, inputMediaRefs
resultState, resultRefs, deliveryState, errorCode
parentBatchId, stepIndex/dependencies（仅批次需要）
```

- status 表达已知执行阶段：queued/submitting/running/cancelling/succeeded/failed/cancelled。
- recoveryState 表达可观察性：normal/reconciling/unknown/interrupted。失联不能伪报 failed/cancelled，也不把未知状态当作空闲。
- resultState 独立：none/collecting/available/unavailable。只有成功取回并校验的本地结果可以称为可交付；上游 succeeded 不证明文件已经在 workspace。
- deliveryState 区分未查看、已查看、已入册、用户丢弃等语义；读取 HTTP 200 不触发破坏性清理。
- `upstreamSettled=false` 时保留准入/占用与媒体租约，防止未知任务仍在 GPU 上运行时调度不兼容的下一项。
- 完成终态不可被迟到轮询倒退。恢复时可以补充身份/结果处置事实，但必须经过 revision 和终态规则，不复活旧执行。

principalId 从服务端认证产生，不信任 body 自报 owner。桌面稳定身份与 workspace 关联；它不等于会轮换的 transport token。保留现有 Web/远程任务的所有者隔离，不能以“统一任务中心”为由返回其他人的作业或私人输出。

输入快照可包含用户有意保存的提示词和冻结后的参数，它是私人业务数据而非诊断日志。凭据只保存引用；恢复无需重放时不要为了日志完整复制全部原图。需要重建排队输入时使用受权限保护的快照及媒体引用。

## 3. 幂等接受协议

新增任务 API 的具体路径在 R5 固化，推荐版本化 `/api/tasks/v1`；不是再实现一套 provider。服务内部调用现有 generation/anima/video 逻辑，将持久化点接入它们。

1. 客户端在提交动作开始生成 requestKey；页面组件销毁后，应用级提交句柄仍能查询这个 key。一次用户重试原请求使用同 key；用户明确“重新生成”才创建新 key。
2. 服务端校验权限、参数和准入，在短事务中建立唯一 `(principalId, requestKey)` 与 taskId，保存参数指纹、冻结输入及 queued 状态。
3. 只有落账完成才报告 accepted；调度器必须在持久记录存在后才能开始上游副作用。相同 key/指纹返回原任务，不同指纹返回冲突。
4. 调度前持久化 submitting 与 provider 身份；再发上游请求。上游 ID 到达后立即持久化，然后才公布 running。
5. 若应答丢失，客户端按原 key 查任务。不能因 502、超时、窗口切换或连接重建再创建第二个 key 自动重提。
6. 如果任务可能已提交、但上游 ID 没有可靠保存，标记 unknown，保留占用；当前 provider 不支持幂等反查时停止自动恢复副作用。

旧路由在迁移期只作为同一调度器的入口，不能新旧接口各调度一遍。运行时所有已接受工作都要有持久身份后，才迁移前端默认路径。旧客户端协议不能制造重复作业；无法兼容时返回升级要求，不静默按新语义猜测。

幂等 tombstone 的保留期必须覆盖允许的客户端重试期限；删除大文件不等于删除 requestKey。过期 key 明确拒绝/要求新动作，不能清掉记录后把迟到重试当全新提交。

## 4. 按 provider 恢复，不编造共同能力

| Provider/任务 | 可做的恢复 | 禁止的推断 |
| --- | --- | --- |
| WAI Comfy、Anima、Krea | 已持久 prompt_id 且后端身份一致时查询 queue/history，核对结果 | history 查不到不等于未执行；不能重发 POST 来“试试” |
| WebUI/reForge 同步生成 | 本地已落盘结果可交付；未知应答标中断/未知并说明 | 没有可查询的上游 job ID，不能承诺重启后自动接回计算 |
| 单视频 | 复用现有 jobId 重连，再补持久 prompt_id、输出取得与保留 | 不重新实现一套与现有 videoStore 互相竞争的轮询状态 |
| 分镜批次 | 持久逐镜身份、顺序、依赖、输入/尾帧及拼接阶段，先核对已发出的镜头 | 重启后直接 `kick()` 会有重复提交风险；禁止默认继续下一镜 |
| 尚未发给上游的 queued 任务 | 已冻结输入完整时可展示“待恢复”；用户确认后再调度 | 不把启动应用变成自动消耗 GPU 的开关 |

providerFingerprint 包含服务端已批准的端点和绑定身份；只有 URL 相同不充分证明是同一后端。无法确认后端替换、工作目录变化或历史截断时，保持需要重新确认状态，不能套用旧 ID 操作未知服务。

恢复器只具有查询、已授权的定向取消和结果收集能力，不具有普通 submit 方法。需要显式继续从未提交的任务时，通过正常调度器和用户动作处理。

## 5. 取消与竞争规则

取消事务先持久化 cancelRequestedAt 和 revision，再调用上游；重复取消返回同一意图。只有客户端 AbortController 被触发，不构成服务端取消完成。

create 的应答丢失时，支持按 requestKey 请求取消：若已存在任务则关联取消；若创建仍在途则保留同 key 的取消意图，后续创建不得忽略它。不能因为 UI 暂时没有 taskId，就让用户以为已取消而后台继续。

每次异步查询/结果下载后重新读取取消意图与 revision：

- 完成已提交在先：取消返回“已完成”，不删除已交付数据。
- 取消意图在先：迟到结果进入待处置/丢弃语义，不自动入册；是否还需等待上游退出由 provider 确认。
- 取消请求 HTTP 返回成功但上游未确认：保持 cancelling，不能释放执行槽。
- 未知上游 ID：不能用全局 interrupt 冒充定向取消。

WebUI 的 interrupt 是全局能力，继续保留现有串行队列与执行/取消共同终结屏障。只能针对已证明由当前应用拥有的活动槽使用；外部作业或恢复后的未知槽，不进行猜测性全局中断。Comfy 保留当前定向队列删除、历史核对及兼容回退的必要差异。

页面资源仍严格释放：poll subscription、事件监听、定时器、Blob URL、音频和渲染实例。把任务所有权移出页面不意味着不再清理资源。

## 6. 结果交付与媒体保留

运行时的 collector 负责从已批准 provider 获取输出，不能等某个页面仍打开才保存结果。结果只接受经 provider 校验的资源引用，不把任意上游 URL 变成 SSRF 下载器。

输出采用 workspace 的先媒体后记录协议，幂等键绑定 taskId + outputIndex/上游输出身份。取图失败可以重试取图，绝不因此重做生成。记录 MIME、长度、hash 和必要的输出元数据；任务输出与作品记录通过引用关联，不强制复制字节。

先确认本地持久可读，再完成会导致上游结果释放的 ACK/清理。上游保留期不足时报告 result-unavailable，不伪造 succeeded-with-download。

“未入册结果”具有独立保留策略：未交付、提交未知、取消未确认的结果不自动清理；到空间阈值先停止新准入并提示处理，不悄悄覆盖用户尚未保存的图。初版不改变用户的自动入册开关。结果保存沿用用户操作的 stable operationId，重连或多窗口点击不重复入册。

删除作品与删除任务结果不是同一件事；只有所有引用/租约解除后才允许 GC。重启恢复还要恢复这些引用，不能只恢复 task.status。

## 7. 任务事件与 UI

初版优先复用现有 HTTP 查询，不为了任务恢复强制引入 WebSocket。列表/单任务响应包含 revision 和 runtimeEpoch；页面只接收不旧于当前代际的数据。后续事件只能用于失效通知，事件丢失后仍能通过查询收敛。

Task Center 从 runtime 查询持久事实；旧 IndexedDB 摘要单列为历史，不和新任务进行双向回写。任务订阅放应用级控制器/组合入口，UI 的 Pinia 只缓存展示与选择状态。

状态未知时允许查看原因、重新核对、对已知身份发起取消、明确创建新的重试任务；最后一种必须提示可能重复，不自动执行。不能把网络错误统一转换成“生成失败，点击自动重试”。

## 8. 分批接入与验收

R5 先实现持久 ledger、准入/idempotency 和恢复器，使用假 provider 验收。保持现有正式 provider 行为，直到相应 adapter 具备完整持久化点。

R6 分开提交 WAI/WebUI、Comfy/Anima/Krea、单视频、分镜批次。每次只迁移一个完整纵向链路：接受 → 执行 → 取消 → 结果 → 重连。批次再拆逐镜与拼接恢复，不用一个 PR 重写所有状态机。

R7 才切 Task Center 与结果收件箱的权威来源，并清理被替换的客户端执行状态。

必需故障测试：

- 创建已提交而 HTTP 应答丢失；相同 key 重试不重复，参数变更拒绝。
- 上游接受但 prompt_id 应答丢失；恢复器 submit 调用次数保持 0。
- 创建/取消/完成三方乱序，迟到 ID 不清除取消意图。
- 切页/销毁组件不调用上游取消，页面监听和 Blob URL 正常释放。
- WebUI interrupt 未完成时下一任务不能启动；未知作业不误取消其他工作。
- runtime 连续两次崩溃、后端身份变更、历史缺失、休眠后的超时核对。
- 结果先生成后断线；只重取结果、不重生成；未入册图仍可找回。
- batch 镜头已提交后崩溃；重开不重复下一镜、不把旧尾帧配给新输入。
- 过期页面响应不能覆盖新代际；远程用户不能查询桌面私人任务。
- 空间不足/worker 故障时先拒绝新副作用，不接受无法可靠记录的新任务。

复用 `server/generation/service.ts` 的准入/取消屏障、`useSDGenerate-results.spec.ts` 的迟到结果测试、现有 videoStore 和 005 恢复原型边界。新增测试须登记现有测试清单；历史通过次数不能充当本轮结果。
