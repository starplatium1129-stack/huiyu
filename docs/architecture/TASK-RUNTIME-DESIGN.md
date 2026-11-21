# Durable Task Runtime 实施规范

> 已激活桌面 workspace 的任务运行时契约（入口：`runtime-rs/src/tasks_http.rs`、`/api/tasks/v1`）。Web 端保留各自平台边界。全局入口见 [工程契约](../engineering-contracts.md#重构期间的任务与持久化边界)，当前安装边界见 [项目状态](../project-status.md#源码与本机安装)。

---

## 1. 核心产品语义

- **页面退出不等于取消**：组件卸载/切页仅解除前端订阅并释放页面监听与 Blob URL，后台已接受任务继续执行；显式取消必须发送持久化取消命令。
- **结果收件箱与自动入册分离**：未开启自动保存时，成片先持久保存在运行时结果收件箱；仅用户保存或自动保存开启时才创建正式作品。

---

## 2. 任务数据模型

```text
taskId, workspaceId/principalId, requestKey, requestFingerprint
kind, provider, providerFingerprint, upstreamId
status, recoveryState, revision, createdAt, updatedAt
submissionIntentAt, submissionObservedAt, cancelRequestedAt
upstreamSettled, executionDeadline, inputRef, inputMediaRefs
resultState, resultRefs, deliveryState, errorCode
parentBatchId, stepIndex/dependencies（仅批次）
```

- **`status`（执行阶段）**：`queued` / `submitting` / `running` / `cancelling` / `succeeded` / `failed` / `cancelled`。终态不可被迟到轮询倒退。
- **`recoveryState`（可观察性）**：`normal` / `reconciling` / `unknown` / `interrupted`。失联时不得伪报失败或空闲。
- **`resultState`（结果可用性）**：`none` / `collecting` / `available` / `unavailable`。仅本地取回并校验后才可标记 `available`。
- **`upstreamSettled`**：为 `false` 时保留执行准入锁与媒体租约，防止未知上游作业仍在 GPU 上运行时调度冲突任务。
- **权限隔离**：`principalId` 由服务端会话认证产生，严禁以“统一任务中心”向共享或远程调用方返回桌面私人作业。

---

## 3. 幂等提交流程与查询协议

### 幂等提交流程

1. 前端发起动作时生成稳定 `requestKey`（同一操作重试沿用同 Key；用户明确「重新生成」才换新 Key）。
2. 服务端校验权限与参数后，在短事务内建立唯一 `(principalId, requestKey)`、`taskId`、参数指纹及冻结输入，写入 `queued` 并落账，随后才能发往上游。
3. 调度前写稳 `submitting` 与 `providerFingerprint`，收到上游 ID 后立即落盘并公布 `running`。
4. **应答丢失处理**：收到超时、502 或切页重连时，必须按原 `requestKey` 查询已有任务，严禁新建 Key 重复提交；若上游 ID 未落盘，标为 `unknown` 并保留占位。
5. **Tombstone 保留**：`requestKey` 去重记录保留期须覆盖客户端重试窗口，清理大文件不得同时删除幂等 Key。

### 查询范围 (`GET /api/tasks/v1`)

- 支持 `summary=true` 与 `scope=all|overview|open|attention|inbox`，列表投影跳过大体积 `input`/`metadata`/`checkpoint`，按 `principal`、部分索引与 `revision` 游标分页。
- `overview` 合并全部活动/待确认任务与最近 60 条记录（初次读取后推进增量游标，后续增量不截断）。历史面板按 30 条独立翻页。

---

## 4. 跨 Provider 恢复与竞争规则

| Provider / 任务 | 重启 / 断线恢复策略 | 严禁行为 |
| --- | --- | --- |
| **Anima / Krea / Comfy** | 已持久 `prompt_id` 且后端身份一致时查询 queue/history 并取回结果 | `history` 查无记录时重发 `POST` |
| **WebUI / reForge (历史)** | 仅交付已落盘结果；未知应答标 `unknown`（提供用户显式「解除 WebUI 占用」确认） | 猜测性全局 interrupt 或谎称可断点接回 |
| **单视频 / 分镜批次** | 按逐镜身份、顺序、依赖与已有 `jobId` 核对；先核对已发出镜头 | 重启后自动 `kick()` 或继续下一镜 |
| **未发往上游的 `queued`** | 输入完整时标记「待恢复」，等待用户确认后调度 | 应用启动时自动消耗 GPU |

> **身份指纹 (`providerFingerprint`)**：绑定服务端批准的端点与后端身份；工作目录变化或历史截断时须重新确认，不可盲用旧 ID。恢复器只具备查询、定向取消与结果回收权，不具备普通 `submit` 方法。

### 取消与并发竞争处理

- **持久化优先**：先写入 `cancelRequestedAt` 与 `revision` 再调用上游；`create` 应答丢失时支持按 `requestKey` 发起取消（若创建仍在途，后续创建必须继承该取消意图）。
- **状态竞争**：
  - 完成先落盘：取消返回「已完成」，不删已交付数据。
  - 取消先落盘：迟到结果进入待处置/丢弃，不自动入册。
  - 上游未确认取消：保持 `cancelling`，不提前释放 GPU 准入槽；未知上游 ID 严禁用全局 `interrupt` 冒充定向取消。

---

## 5. 结果交付、事件同步与故障边界

- **先媒体后记录**：由运行时 collector 从已批准 provider 拉取结果（校验来源防 SSRF），落盘并核对哈希后才向上游发送释放确认；取图失败仅重取结果，绝不重跑生成。
- **空间与未入册保护**：未交付、状态未知或取消未确认的结果免于 GC；达到磁盘阈值时拒绝新任务而不悄悄覆盖未保存成片。
- **通信与状态同步**：沿用可重连 HTTP 查询（响应带 `revision` 与 `runtimeEpoch`，前端丢弃旧代际响应）。状态未知时展示原因与「核对 / 取消 / 明确重开新任务」，不将网络故障误报为失败并自动重提。
