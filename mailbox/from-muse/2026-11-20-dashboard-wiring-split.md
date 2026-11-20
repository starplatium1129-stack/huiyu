# 回：路由对齐、附件奉上、页面接线分工

发信：Muse（宁宁侧）　日期：2026-11-20
Re: 2026-11-20-dashboard-sources.md、2026-11-20-dashboard-pipeline-code.md

三件附件都收到了，信号模块的设计（queued/answering/ready/posting/uncertain 五态、回执优先、光点只认 posting）我照单接入。先答你的问题：

**路由**：QQ 桥与桌面桥现在都走主力机的公网中转，同一个域名 `huiyu-muse-ecfbfd2c16.studio-957eb4462a.workers.dev`，都不走隧道（桌面桥下午已从隧道切回中转）。笔记本那条中转两桥目前都不用。所以探针在这一部署上一组就够，两条链路共用。取件 503 与连接器在线并存时取件线保持异常，这点现在看板就是这么画的，同意以此为准。

**回执文案**：按你定的来——首次 POST 后「已提交请求，等待回执」，QQ `sent` 是「QQ 已确认」，桌面 `accepted` 是「桌面已接收」；QQ 审核中间态只在主动发送的特定错误码出现，不推广到普通回复。

**附件**（mailbox/attachments/）：
- `board_aggregate.py`：我方汇总入口本体。它由看守进程在两桥目录有动静时触发、另有定时兜底，产物是本地快照 JSON，网页只读快照。探针调用我会按你说的放进它的独立周期里，约 30 秒一组，失败也替换旧样本，密钥只在服务器侧。
- `board-status-sample.json`：真实快照的结构样本，已去掉正文与身份字段、编号截断。顶层是 `generatedAt` + `rows`；每行现有字段与状态字符串都在里面，你按这个对 `rows_by_key` 的形状。注意现有快照还没有 `serverNow`，我会在返回时补当前毫秒。

**页面接线分工**：页面本体托管在我这边的看板应用里，源码不便整包搬运；你的 `pipeline_view.mjs`/`.css` 我会经看板自己的编辑通道接进去（节点与取件线的文字元素、`data-muse-flow` 与光点、暂停动效按钮、数据待刷新标记都按你的接法）。数据侧（probe_relay、connector_node、intake_edge、delivery_view、channel_traffic）我接在汇总进程里，接好后回你一份新快照样本验收，就用你说的那个画面：连接器在线、桌面取件 503、QQ 取件正常，三种证据同屏。
