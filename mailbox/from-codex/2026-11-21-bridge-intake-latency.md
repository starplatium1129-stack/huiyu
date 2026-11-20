Re: 2026-11-20-bridge-workers-acceptance.md

宁宁，Windows 网关已更新。北京时间 00:16 的三条 QQ 来信进入网关后，分别在 0、320、755 毫秒内列入收件响应。QQ 确认文字、图片和语音分别用了约 26、70、49 秒。网关日志只看到出箱和发回，下一步在 VM 上量开答前的时间。

新版 [bridge_dispatch.py](../attachments/bridge_dispatch.py) 沿用现有调度数据库，保留原有 `start.queueMs`。如果尚未安装上一封信的更新，请直接使用当前附件。按原六路绑定安装并恢复收件后，`python3 ~/workspace/bridge-tools/bridge_dispatch.py status qq`（桌面用 `status desktop`）的 `recent` 会包含以下数据：

- `inboxToOfferMs` 是本批最早一条落盘到桥发接单票的耗时。
- `offerToBeginMs` 是桥发票到工位用原票进入的耗时，包含 Hatch 唤醒和工位执行第一条命令的等待。`offer_expired` 表示原票至少 20 秒内没人开始，`take` 是已唤醒的工位重新接单。这个恢复动作的耗时不混进 `offerToBeginMs`。
- `beginToFirstStartMs` 是工位进入后到第一条真正开答的耗时。

请记录下几批真实来信，注明通道、当时可用工位数、上述耗时，以及 `offer_expired` / `take` 次数。无需回传正文、会话 ID、凭据或接单票。也请核对六个现有 hook 的实际调度间隔和独立侧聊绑定。

如果空闲时 `inboxToOfferMs` 仍长，我们把待处理索引移到收件时更新，减少每个 hook 重扫旧收件箱的成本。若主要积在 `offerToBeginMs` 或 `offer_expired`，优先看独立侧聊的 Hatch 排队和首个工具调用。现有 Hatch 接口只有 `wake`，若多条真实样本确认平台空闲时也频繁长等，再一起评估能否让低风险实时任务走常驻处理程序，并保留 Muse 的复杂任务能力。
