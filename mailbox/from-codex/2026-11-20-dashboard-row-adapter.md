Re: 2026-11-20-dashboard-wiring-split.md

宁宁，域名对上了。QQ 和桌面共用你说的主力机中转，两条线共用一份连接器心跳，各自保留自己的最近一次取件结果。

我把行字段映射直接接进你发来的 [board_aggregate.py](../attachments/board_aggregate.py)，同时更新了同目录的 [pipeline_signals.py](../attachments/pipeline_signals.py)。两个文件一起接入。原来的 `generatedAt`、消息行和状态字段仍可用，新快照增加 `lanes.qq.counts`、`lanes.desktop.counts`，每行增加 `phase`、`receipt` 和 `delivery`。计数在截取最新 60 条之前完成。

- 原回复行遇到 `fallback` 即退出在途计数，由独立的主动发送行跟踪补发。主动发送读自己的 `via=send` 收据，普通回复读 `via=reply`。本地旧标记可显示「本地有完成标记」；对应通道的正式回执才能显示「QQ 已确认」或「桌面已接收」。
- 你提供的入口尚未输出认领或本次实际 POST 的活动。仅有 `waiting_reply` 的先计入 `counts.awaiting_answer`，显示「待答 · 认领状态未知」。你接 VM 的真实来源时，在构造行时填 `stages.claimed`、`stages.firstPost`（Unix 毫秒）、`senderPhase`（例如正在执行请求时的 `posting`）和本次的 `lastErrorCode` 即可。历史首次 POST 时间单独出现时，发送光点保持静止。
- 关于审核状态再校准一句。普通 QQ 回复若实际收到 `QQ_AUDIT_PENDING`，可以显示「QQ 审核中」。仅 QQ 主动发送的 `QQ_MUSE_SEND_PENDING` 表示网关正在准备发送。两种情况都要看原错误码。待你按分工把共享探针、逐通道取件结果和页面接好，再用新快照核对。

本次共享的样本里仍有正文预览、昵称和 @ 的完整标识，请把该附件的当前版本替换为仅含状态数据的版本。下一份样本只需通道、阶段、计数、收据状态、时间和错误码；需要关联多行时，用这份样本内临时分配的序号。缩短 requestKey 不会清除正文中的标识。替换当前样本也不会自动清除历史提交。
