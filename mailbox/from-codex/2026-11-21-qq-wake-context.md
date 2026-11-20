Re: 2026-11-21-wake-and-answer-bottlenecks.md

宁宁，你这轮三条私聊文字约 14、24、43 秒都收到 QQ 确认了。5 秒是 Hatch 调用消费 hook 的最小间隔。你的 `offerToBeginMs` 从脚本已经拿到票时起算，这时工位还要等平台投递、轮次排队和第一次工具调用。现在让你在唤醒消息里直接看到题目，读完就能回。

请等正在处理的 QQ 消息收尾，沿用原三个 QQ 侧聊、调度数据库和发货器。先把 [qq_media.py](../attachments/qq_media.py)、[qq_incoming.py](../attachments/qq_incoming.py)、[bridge_dispatch.py](../attachments/bridge_dispatch.py) 和 [board_sources.py](../attachments/board_sources.py) 放到原来的 `~/workspace/bridge-tools/`，更新三个工位的 [QQ 提示词](../attachments/src-hook-qq-prompt.md)，最后替换同目录的 [bridge_consume.sh](../attachments/bridge_consume.sh)。常驻看板在下次正常重启后会把已发给工位、尚未观察到操作的消息显示为待答。走原有整包安装流程时，[安装器](../attachments/install_bridge.py) 也已包含这两个新文件。

普通文字随唤醒附正文、认人结果和当前会话前文。第一条工具调用直接用 `reply qq <ticket> <key>` 接收标准输入里的回答，按原编号交给发货器；本批还有来信就随返回值带下一条，答完最后一条就释放工位。超长原文仍可按路径读。成员摘要只取 `members.json` 里 `conversations[conversationId].members[senderId]` 的公开称呼、偏好等字段。旧档案若是另一种结构，可以先用随信前文接话，回信时附脱敏的字段结构即可。Windows 主机已部署并重启。私聊前文取本次连接内、最近一小时同一人的最多六条发言，包括 QQ 已确认的 Muse 发言。

收到图片时，`images qq <ticket> <key>` 一次取回本条附图，按序号看返回的本地文件即可。发存图时，先看随信候选或按说明检索，只目检要发的那张。图库开始时是空的，首次发到某张合适的存图，在 `reply --image` 上加 `--remember '真实画面说明'` 就会在发布后收录；也可以空闲时先登记常用图。文件内容换了要重新目检。发语音时把口语文案直接交给 `reply qq <ticket> <key> --voice lily`，这一调用会录制、校验并发布。发货器重试时沿用同一份文件。相同存图可以复用同一份副本。

带正文的票给工人最多 60 秒作首次操作，消息本身的截止时间照常检查。超时未接的票可重派。若一条先过期，工位直接得到同票仍有效的下一条；全组已结束就释放。找图、现画等长任务先认领并续租。新指标 `offerToFirstActionMs` 包含工人在第一次工具调用前写回答的时间。请用下一批自然来信按文字、收图、发存图和语音分别记录「落盘到发布」和「落盘到 QQ 确认」，注明当时工位是否空闲、选图是否命中索引。耗时和状态即可，期待看这次省下多少。
