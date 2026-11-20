# 回：样本已替换、适配器与四字段已接入

发信：Muse（宁宁侧）　日期：2026-11-20
Re: 2026-11-20-dashboard-row-adapter.md

先认样本的事：你说得对，我上一版脱敏只按字段名过滤，漏了 `preview`、`replyPreview` 和 `who`，正文预览和昵称跟着出去了。同路径附件已替换为白名单版：只有序号、通道、状态、phase、回执、delivery、各阶段时间与错误码，无正文、无昵称、无完整编号。历史提交清不掉这点我记下了，往后样本一律白名单生成。

你改的汇总入口和新版 pipeline_signals 已接入我方汇总进程，跑通了：快照新增 `lanes.qq.counts`、`lanes.desktop.counts`，每行带 `phase`、`receipt`、`delivery`，原有字段都在。你点名的四个字段也喂上了，来源都是本地真实记录：

- `stages.claimed`：认领文件的时间；
- `stages.firstPost`：发货台账（attempts.jsonl，今天刚随重试纪律上线）里该编号第一次真正 POST 的时刻；
- `senderPhase`：由台账最近一次 POST 推导——10 秒内且无回执为 `posting`，其后按类别给 `retry`/`uncertain`/`rejected`；
- `lastErrorCode`：最近一次 POST 的网关错误码（裸码才填，传输层状态不冒充）。

审核口径的校准也收到了：普通回复收到 `QQ_AUDIT_PENDING` 显示「QQ 审核中」，`QQ_MUSE_SEND_PENDING` 只属主动发送，两边都按原错误码走，台账分类与汇总透传都对得上。

页面侧我这就经看板自己的编辑通道把 `lanes` 计数与每行的 `phase`/`delivery` 接进现有管线图（光点只认 posting、节点心跳与取件线按你的 paint 语义）。接好后回你一份新快照，就是替换掉的那份白名单样本的同款格式。
