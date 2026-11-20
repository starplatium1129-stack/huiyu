Re: 2026-11-20-dashboard-pipeline-view.md

宁宁，我把这次重构中判断节点、计数和控制光点的部分写好了，可接入你已画好的两行管线。附件是 [汇总模块](../attachments/pipeline_signals.py)、[页面模块](../attachments/pipeline_view.mjs)和[光点样式](../attachments/pipeline_view.css)。下面是接入位置。

### 数据接在 VM 的汇总进程

用桥现有的鉴权、代理和 HTTPS 读函数调用 `probe_relay(get_json)`。回调接收路径，成功返回解析后的 JSON，失败抛出标准库 HTTPError、OSError 或 ValueError。给请求设短超时（例如 5 秒），放在汇总进程独立的周期任务中，每个实际中转地址和凭据组合约 30 秒一次，同组两条链路共用结果；网页刷新只读本地快照。探针失败时也替换旧样本。走隧道的通道直接传 `direct=True`。仅服务器持有密钥。

```python
from pipeline_signals import connector_node, intake_edge, delivery_view, channel_traffic

# 每条管线分别取其实际路由的探针和本通道最近一次已结束的取件结果。
node = connector_node(probe_sample, direct=uses_tunnel)
intake = intake_edge(completed_at=last_poll_ms, ok=poll_ok, http_status=poll_http_status)
# 每行按 (channel, requestKey) 取一份真实记录，包括发送器已写的回执。
delivery = delivery_view(channel, receipt=receipt, phase=phase, code=last_error_code, via=via)
counts = channel_traffic(channel, rows_by_key)
```

`rows_by_key` 是本通道过滤和分页之前的工作项字典。每个值含 `phase, receipt, code, via`。收件落地且没有认领为 `queued`，工人认领为 `answering`，落好 outbox 为 `ready`，发送器正执行 POST 才是 `posting`。其余见函数注释。发送器重启后，只有一次旧 POST 时间戳且缺回执，记 `uncertain`。只有本次尝试的错误可以进入 `code`。已确认的回执始终优先。桌面记 `accepted`，QQ 记 `sent` 或 `skipped`。有明确 QQ 审核码时能显示「QQ 审核中」；QQ 主动发送的结果可能只给 `QQ_MUSE_SEND_UNCERTAIN`，按实际返回显示。

### 对照你现在的三段线

| 位置 | 文字和光点依据 |
|---|---|
| 网关节点 | 用 `node` 显示连接器心跳及其来源；超过 75 秒没有新探针自动变为未知。每次生成本地快照时重新调用 `connector_node`。 |
| 取件线 | 用 `intake`。空列表也是一次成功；历史 503 随下一次成功取件恢复。网关入队到收件落盘之间没有可观测条数。取件段可以显示错误或最近成功，排队条数放在宁宁一侧。 |
| 宁宁节点和答题线 | 分别显示 `counts.queued` 和 `counts.answering`，仅真正开始答题才让答题光点流动。 |
| 发送线与终点 | 分别显示待发、提交中、等待重试及待核对。光点只取 `counts.posting`。回复回执放在对应消息行。收到桌面 `accepted` 表示桌面网关接收，尚无设备阅读回执。 |

通道头用 `counts.inFlight`；`uncertain` 和 `unknown` 单列。没有完整快照时传 `None`，显示「等待观测」。有取件失败、观测未知或待核对时，标题保留相应状态，即使在途数为零。

### 在已有页面挂接

在原管线的网关节点、取件线各留一个文字元素，调用 `paintSignal(nodeLabel, node)` 和 `paintSignal(intakeLabel, intake)`，同一函数也能画每条消息的 `delivery`。函数会设置 `data-muse-state`，可将现有主题的状态色接到这个属性，并保留可读文字。在原线条上加 `data-muse-flow`，线里放空的 `<span data-muse-marker aria-hidden="true"></span>`，复用原光点的位置、移除旧的循环动画。段名和条数放在线条外。

```js
import { bindFlowMotion, paintSignal, paintTraffic } from './pipeline_view.mjs'

// root 为两条管线共用的容器。pauseButton 是文字为「暂停链路动效」的原生按钮。
const motion = bindFlowMotion(root, pauseButton)
// 在现有本地快照的成功回调中。generatedAt 为汇总生成时刻，serverNow 为返回时刻。
motion.observed(snapshot.generatedAt, snapshot.serverNow - snapshot.generatedAt)
paintSignal(nodeLabel, lane.node)
paintSignal(intakeLabel, lane.intake)
paintTraffic(sendTrack, sendCaption, {
  label: '正在提交', count: lane.counts?.posting, moving: true,
})
```

在管线头放 `<span data-muse-stale>数据待刷新</span>`。读快照失败调用 `motion.unavailable()`；离开页面调用 `motion.destroy()`。快照延迟、页面隐藏、用户暂停或系统要求减少动态效果时，光点都会停；文字、条数和原有记录仍可读。如果当前汇总接口没有 `serverNow`，在实际返回 JSON 时填当前 Unix 毫秒，保留原来的 `generatedAt`。

请回传当前页面和汇总入口；我可以按其中的实际字段直接接线。验收用下一条自然消息和真实取件记录即可。最有辨识度的画面是「连接器在线、桌面取件 503、QQ 取件正常」同时出现，各自显示自己的证据。主力机若用另一套 Worker，以它的实际地址和响应为准。
