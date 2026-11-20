# 独立图像与视频推理接入指南

本项目原生推理基于独立 Python 运行库与官方 Diffusers 架构，不依赖 ComfyUI 节点即可完成文生图、图生图、局部重绘、适配器生图及漫画后处理。

---

## 1. 核心使用方式

### 快速一键准备（推荐）
从欢迎页的「配置绘图」进入控制室。已有可用模型时，可直接选择模型并进入画室。

1. 核对存放位置与空间，首次出图可选推荐的 MiaoMiao Harem Anima 1.6。
2. 确认许可后点击「下载并自动配置」。绘遇下载并校验运行库和模型，再保存引擎设置。
3. 若提示「重启并继续」，重启后回到配置页继续所选模型。点击「去画室生成第一张图」，可填入示例画面或写自己的描述，然后点击「生成图片」。

模型与运行库组件共用连接池，最多同时下载 4 个不同文件；公开大文件会用不超过 128 KiB 的前缀比较官方源与镜像，先用较快完成的来源。Qwen-Image 2.1 与 MOSS 的公开组件另有已逐项匹配大小和 SHA-256 的 ModelScope 固定版本来源，登记在 `tools/inference/managed-model-mirrors.json`；MIAOKA 作者主权重来源不变。带凭据的请求不参与镜像选择。下载中断保留可续传字节，每个文件仍须通过完整大小与 SHA-256 校验后发布；取消或任一文件失败会先停止并收妥同批在途下载。

### 在另一台绘遇上使用原生绘图

两台电脑需运行含此功能的绘遇版本。显卡所在电脑先准备本机原生模型与运行库，在「控制室 → 绘图与模型 → 原生绘图 → 绘图引擎与远程连接」选择本机原生引擎，开启允许连接、生成密钥并保存，重启后确认端口正在监听。本机端口默认 3211，只监听回环地址；使用 Tailscale 时运行 `tailscale serve --bg --tcp=3211 tcp://127.0.0.1:3211`，通过 tailnet 私网转发，不需要开放局域网防火墙端口。

转发就绪后，出图机的「原生绘图」标题下显示可复制的本机远程绘图地址和连接密钥复制按钮。使用端在控制室选择「连接另一台绘遇」，粘贴地址与密钥，保存后点击「重启并检查远端」。重启回到配置页后，从远端已就绪的模型中选择一个并进入画室。远端绘遇须保持运行；模型和 LoRA 以远端可用状态为准，素材会传到远端，结果和任务记录保存在使用端。远端生成沿用本机原生显存交接，可能停止该电脑上的语音、聊天模型及受管 ComfyUI。远程支持 Anima、Krea 2、Qwen 和 MOSS 图像任务；漫画处理需切回本机原生引擎，视频仍使用单独的引擎设置。连接中断时查询原任务，不自动重复提交。

连续使用同一参考图时，支持素材复用的出图机会按内容摘要确认已上传的文件，使用端只传缺少的图片。下载原图时，若连接中断且出图机提供了文件长度和强 ETag，使用端会在本次下载中自动续传一次。出图机提供 SHA-256 时，使用端会在接收完整原图后核对摘要。

密钥保存在两端本机设置中。端口使用 HTTP，传输依赖 Tailscale 私网加密，不应直接暴露到公网；撤销转发使用 `tailscale serve --tcp=3211 off`。状态中的模型就绪只表示远端文件可用，CUDA 与成图仍需在实际设备上确认。

### 用 Muse 或其他 AI 助手查询素材和出图

Muse 和其他能发送 HTTPS 请求的 AI 助手都可以使用同一个私人中转。出图时让绘遇保持运行，给助手配置中转根地址和 `X-Token`。助手用 JSON 提交任务、查看进度，等图片就绪再下载文件。中转会接收提示词、任务回执和原图。每个中转对应一台出图机，图片最多保留 48 小时，单张上限 32 MiB，总容量 256 MiB。也可以继续使用已配置的 Tailscale 私网直连。

首次开通时，在出图机控制室开启「允许连接」并保存。使用项目要求的 Node.js，在项目根目录运行 `.\tools\muse-relay\setup.ps1`，按 Cloudflare 的提示登录个人账号。首次使用 Workers 时需选择可用的 workers.dev 子域名。开通后进入「控制室 → 绘图与模型 → 原生绘图 → Muse 远程出图」，可以查看、复制中转地址与调用方的 X-Token。使用命令行时也可运行 `.\tools\muse-relay\setup.ps1 -CopyToken`。已运行的新版绘遇会自动读取首次配置。更换已有配置后重启绘遇。Cloudflare 的免费套餐有每日用量限制。[Cloudflare 官方用量说明](https://developers.cloudflare.com/durable-objects/platform/pricing/)

让助手先读中转根地址 `GET /`。返回的 JSON 中，`resultFlow` 列出轮询路径、下载条件和响应类型。后续 API 请求都带同一个 `X-Token`。读取 `GET /api/muse/connection` 可查看笔记本是否在线，`GET /api/muse/guide` 提供素材与出图接口的完整用法。调用方应发送自己的应用名称，例如 `User-Agent: Huiyu-Muse/1.0`。实测 Cloudflare 会对默认的 `Python-urllib` 标识返回 403/1010。桌面之间的模型探测和上传参考图仍使用上一节的桌面连接方式。

**查目录**可用 `GET /api/muse/catalog`。查宁宁服装用 `?kind=outfit&character=nene`。`kind` 也可为 `character`、`media`（默认，场景和蓝图）、`scene` 或 `blueprint`。支持 `search`、`character`、`category` 和 `rating`。`rating=R18` 等值在服务端筛选，`ratings` 列出可用分级。用 `pageSize=500` 快速枚举，跟随 `nextPage`。服装详情用 `GET /api/muse/catalog/outfit/{完整 ID}`，例如 `/api/muse/catalog/outfit/studio/natsume-maid`，返回 `tokens` 和 `compatibleModels`。场景和蓝图详情可查种子与变体上限。

**按目录出图**可用 `POST /api/muse/jobs`，传场景或蓝图 `id` 和新生成的 `requestKey`（推荐 UUID）。省略尺寸时使用配方的画幅。笔记本想用 832×1216 出图，可直接提交 `{"id":"sc093","width":832,"height":1216,"requestKey":"replace-with-new-uuid"}`。宽高需成对提供，并符合所选模型的范围。可加同一角色的 `outfitId` 换装，也可只传 `outfitId` 生成这套服装。跨角色或无法指定唯一角色的场景换装会返回 `OUTFIT_INCOMPATIBLE`。目录配方支持 `anima-miaomiao-v1.6`（默认）、`moss-miaomiao-base-v1.0` 和 `moss-miaomiao-base-v1.1`，以出图机已安装版本为准。本机新建或改写的场景可在画室用当前内容出图。

**自定义或批量出图**也用同一接口。自定义提交 `prompt` 与 `requestKey`，可加 `modelId`、`seed`、`variants`、`negative`、`steps`、`cfg` 或成对的 `width`、`height`，模型参数由选用的模型校验。Anima 可传 `character` 自动匹配已安装的 LoRA。多个任务用 `POST /api/muse/batches`，用 `ids` 批量传目录 ID，或用 `items` 逐项传出图参数。整批可共用顶层 `width` 和 `height`，某一项需要不同尺寸时在该项内成对覆盖。每项最多 8 张，每批合计最多 16 张。提供 `seed` 时后续变体递增。网络重试复用原请求体和 `requestKey`。

**Anima 高清放大**只需加 `"upscale":"ultrasharp"` 或 `"upscale":"remacri"`。UltraSharp 放大 1.5× 后按 Euler / Normal、10 步、CFG 5.5、重绘 0.8、Shift 3 重绘。Remacri 纯像素放大 1.5×。宽高仍填放大前的尺寸，第一轮沿用原配方或本次传入的步数。顶层 `upscale` 可用于整批，`items` 每项可以覆盖，传 `"off"` 可关闭该项放大。需要放大时，出图机须先安装对应权重。

**直接收图**时，已有目录 ID 或提示词就直接提交。走 Cloudflare 中转且客户端能接收二进制时，用回执里的 `receivePath` 等原图，可跳过目录详情、队列和单图状态查询。需要查看进度时才读批次 `statusPath`。

**查刚提交的图**：单张和多张都返回 `batchKey` 和顶层 `statusPath`。直接 GET 这个路径，也可用 `GET /api/muse/batches/{batchKey}`。从 `items` 看每张图的 `status`、`progress` 和成功后的 `resultUrl`。`waiting` 表示已排队，继续查同一路径即可。取消整批或某张图时，向对应的 `cancelPath` 发 `DELETE`。升级前的单图若仍保有回执，可用当初的 `requestKey` 查批次路径，也可沿原回执路径读取 `job`。

**队列和恢复**用 `GET /api/muse/queue` 查看排位。丢失编号时用 `GET /api/muse/jobs` 找回近期记录。`items` 同时含 `entryType=batch` 的批次和 `entryType=image` 的单张任务。可传 `since`（Unix 毫秒或 RFC3339），并以 `nextBefore` 翻页。

**助手自动收原图**

1. 提交回执中，每张图的 `items[].next` 都给出了下一次请求的 `method`、`path` 和 `accept`。当 `accept` 为 `application/json` 时，等 `retryAfterSeconds` 秒（默认 2 秒），再用读 JSON 的工具查批次的 `statusPath`。同一批只需查一次就能看到所有图片的进度。`next` 为 `null` 时结束该项，并按 `status`、`deliveryStatus` 和 `error` 说明原因。
2. 某一项的 `resultAvailable` 为 `true` 且有 `resultUrl` 时，`next.accept` 会变为 `image/png`。使用文件下载工具，带同一个 `X-Token` 请求该地址。原图达到 1 MiB 时，回执的 `next.ranges` 会给出四个 `Range` 值。支持并发的工具可对同一个地址同时发四次 GET。每个 `206 image/png` 响应的 `Content-Range` 和 `Content-Length` 须与所取区间匹配，超时只重取缺失的区间。也可以用一次 GET 收取 `200 image/png` 整图。
3. 并行取图按起始偏移拼接。保存前检查 PNG 文件头（十六进制 `89504e470d0a1a0a`），将整图字节数和 SHA-256 与回执的 `resultBytes`、`resultSha256` 比对。直接下载整图时，也核对响应的 `Content-Length`、`X-Result-Bytes` 和 `X-Result-Sha256`。校验通过再展示图片、告知用户完成。

**沿用 receivePath 的助手**可以对每项的 `receivePath` 长轮询，单图也可用顶层的同名字段。每次 GET 最多等待 20 秒。收到 `202`，或工具显示 `200 application/json` 且正文含 `"pending":true`，都按等待处理。即使旧回执里有 `"ok":true`，也要继续 GET 同一地址。重试间隔优先读 `Retry-After`（秒），缺省用 2 秒。JSON 只用于读状态，下载整图沿用上述校验。断线后可用原路径继续接收。

**等待图片传完**。中转回执中，`status=succeeded` 表示笔记本已经出图，`generationMs` 是生成耗时。`deliveryStatus=transferring` 表示中转还在收图，`deliveryBytes` 为已经校验的字节数。即使调用方退出，中转也会继续接收已经提交的批次。中转收齐并校验后，`deliveryStatus` 变为 `ready`，`deliveryMs` 记录传送耗时，手机自己的下载时间另算。中转已收全的图在笔记本离线后仍可下载。回执保留 `resultBytes` 和 `resultSha256`。遇到 `expired`、`storageFull`、`invalidReceipt` 或 `integrityError` 时，结束该项并报告原因。遇到空响应、429 或 503，按 `Retry-After` 或短暂退避重查原路径。

**命令行取图**。用 Python 3.11+ 运行 `py tools/muse-relay/get_result.py <HTTPS地址> <batchKey> 成图.png`。工具提示输入密钥，也可读取环境变量 `MUSE_TOKEN`。先发整图请求。原图达到 1 MiB 且 1.5 秒内尚未收到完整图片时，再开四路并行下载，采用先收齐并通过校验的结果。两种方式都失败时可用可续传分片。加 `--single-connection` 可只用原来的取图方式，取批次中的第 2 张时加 `--item 2`。

带 `--submit` 可以一条命令提交、等待并保存原图。给出 JSON 请求文件时运行 `py tools/muse-relay/get_result.py <HTTPS地址> '@request.json' 成图.png --submit`，也可直接把 JSON 对象作为第二个参数。文件可只写 `{"id":"sc093","upscale":"ultrasharp"}`，工具会生成一个 `requestKey` 并在提交前打印。中断后用这个编号继续取图。批量 JSON 仍可用 `--item` 选择要保存的那张。

**弱网取图**。从 `resultUrl?part=0` 开始依次取 128 KiB 分片，最后一片可较小。收到的字节数应等于 `Content-Length`，分片 SHA-256 应等于 `X-Part-Sha256`，按 `X-Result-Offset` 写入。掉线只需重取缺少的分片。所有分片拼好后，用回执的大小和 SHA-256 核对整图。重复运行下载工具时可复用这些分片。

**断点续传**时用同一个地址和 `X-Token` 下载 `resultUrl`。断线后保留部分文件，从已收到的 `N` 字节发送 `Range: bytes=N-`，并用原 `ETag` 作为 `If-Range`。收到 `206 image/png` 且 `Content-Range` 从 `N` 开始时追加，完成后核对 `resultBytes` 和 `resultSha256`。收到 `200 image/png` 时按完整文件接收，通过整图校验后再替换。桌面端任务记录保留约 7 天，原图最长保留 48 小时，受 2 GiB 缓存上限约束。

### 在桌面角色聊天中使用 Muse

在绘遇打开「角色聊天 → 聊天设置 → 聊天模型」，选择 **Muse**。点「复制给 Muse 的收信说明」，把说明交给正在帮你出图或收 QQ 消息的 Muse，给现有连接增加桌面收信任务。使用 Cloudflare 中转的旧连接需先在出图机用 `tools/muse-relay/setup.ps1` 更新 Worker。使用已启动的 QQ Tailscale 虚拟机专用端口时，沿用原来的地址与端口。

| 连接方式 | 取桌面来信 | 回到桌面角色房间 |
| --- | --- | --- |
| 远程绘图端口或 Cloudflare，沿用该地址的 `X-Token` | `GET /api/muse/desktop/inbox` | `POST /api/muse/desktop/reply` |
| QQ 的 Tailscale 专用端口，沿用已授权的虚拟机 | `GET /desktop/pending` | `POST /desktop/replies` |

请让 Muse 把已有的定时任务改成两个独立的持续收信任务，桌面、QQ 各保持一个 GET。两个收件地址均可加 `?wait=25`，按秒等待，上限 30 秒。队列有来信立即返回，空队列等到期限才返回。HTTP 超时设为至少 40 秒。省略 `wait` 时立即取一次，也可沿用 `Prefer: wait=20` 请求头，两者同时出现时优先用 URL 参数。旧桌面网关走公网时，中转会在 Muse 等待期间每隔约 3 秒再取一次，收件结果标记 `operations.inboxWaitMode: "relay-poll"`。收到空列表就续接同一地址。如果直连旧网关，`operations.inboxWaitSeconds` 缺失或为 0 时，空列表返回后等 2 秒再取。连接失败时按 `Retry-After` 或逐步退避重连。

用 `conversationId` 区分对话，按 `items[].messages` 中的角色设定和聊天上下文生成文字。每个 `requestKey` 只生成一次，写好即在 `expiresAt` 前提交 `{"requestKey":"来信编号","text":"角色的回答"}`，收到回执后继续取信。投递重试用原编号和原回答。桌面发送后可以停止等待，已撤回或过期的问题需在房间里重新发送。

聊天设置显示「Muse 最近已来收信」时，表示绘遇在最近 90 秒收到过桌面收信请求。如果一直显示等待，先让 Muse 核对收信地址与任务，再点「重新检测 Muse」。

### 让 Muse 收发 QQ 群消息

在「服务与连接 → 手机聊天 · QQ」绑定目标群或私聊，在「交给 Muse 的 QQ 对话」勾选相应会话并保存。群里默认通过 @ 提问。想让 Muse 参与平常的群聊，勾选「也接收没有 @ 机器人的群消息」，并在 QQ 给机器人开启获取群内全部消息的权限。需要 Muse 自己开口时，再勾选「允许 Muse 主动发消息」，接收方也要在 QQ 允许机器人主动发送。具体频次和权限由 QQ 执行。[腾讯消息收发规则](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)

使用 Cloudflare 或绘图端口直连时，请开启原生绘图的「允许连接」。已有 Cloudflare 中转需在原出图机运行 `tools/muse-relay/setup.ps1` 更新 Worker。使用下文的 Tailscale 虚拟机专用端口时，只需更新绘遇。

在 iPhone 的 **Muse from Meta** 里，可以直接用聊天更新绘遇连接。Muse 的工具和后台任务运行在自己的云电脑上，手机用来下指令和确认操作。若已用 Tailscale 收过 QQ 消息，可对 Muse 说「请沿用绘遇现有的 QQ 连接，读取原来 `/qq/pending` 返回的 `operations`，更新我的自定义连接器。保留现在的收信任务，加入主动发文字、发送我选的图片和搜索公开网页。向 QQ 发送前按我的 Muse 授权执行，收到 QQ 回执后再告诉我送达。」可在 Muse 的 Settings → Connectors 管理授权。[Muse 云电脑说明](https://muse.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse) · [Meta 自定义连接器帮助](https://www.meta.com/help/superintelligence/1687253048996149/)

使用 Cloudflare 或绘图端口的客户端使用上面的连接地址和 `X-Token`，可按下面的协议定时收信。

> 独立持续请求 `GET /api/muse/qq/inbox?wait=25`，HTTP 超时至少 40 秒，空结果立即续接。用 `conversationId` 区分会话，`senderId` 区分发件人。普通聊天直接用来信附带的 `recentMessages`，文字写好就回传。`ambient: true` 表示普通群消息，可自行决定是否插话。向 `POST /api/muse/qq/reply` 提交 `{"requestKey":"来信编号","text":"你的回答"}`，静默跳过则提交 `{"requestKey":"来信编号","skip":true}`。每次请求携带 `X-Token`。同一编号只处理一次，遇到暂时故障，按 `Retry-After` 或逐步退避，在 `expiresAt` 前用相同编号和内容重试。`status: sent` 表示 QQ 已确认，`skipped` 表示已静默处理。

已有待答消息时，收件箱立即返回。收件箱为空时，网关可以等 8 秒，这期间有新消息就立即返回。原有轮询任务可以继续使用同一地址和参数。`operations` 给出当前连接可以调用的地址和参数。

群友可以单独 @ 机器人，也可以发「@机器人 帮这幅画想个标题」或 `/muse 问题`。绑定、帮助和取图等命令由绘遇处理。文字限 1600 字，每条来信可以回一段文字，并附一张图片或一段语音，也可以只回附件。群回复窗口为 5 分钟，私聊为 60 分钟，`expiresAt` 是 Unix 毫秒。待答消息在内存中保存，返回 410、重启或重新绑定后需要重新提问。

| Muse 要做的事 | 私网直连或 Cloudflare | Tailscale 虚拟机端口 | 请求内容 |
| --- | --- | --- | --- |
| 查可联系的群和私聊 | `GET /api/muse/qq/targets` | `GET /qq/targets` | 使用返回的 `conversationId` 选择目标 |
| 查看群上下文 | `GET /api/muse/qq/context/{conversationId}` | `GET /qq/context/{conversationId}` | 用 targets 中的群会话编号，返回按网关收录顺序排列的 `items` |
| 回复来信 | `POST /api/muse/qq/reply` | `POST /qq/replies` | 来信 `requestKey`，加 `text` 或一个附件，也可同时提交文字和附件 |
| 主动发一条消息 | `POST /api/muse/qq/send` | `POST /qq/send` | 新 UUID 作 `requestKey`、目标 `conversationId`、`text`、`image`、`audio` 三选一 |
| 搜公开网页 | `POST /api/muse/qq/search` | `POST /qq/search` | `query` 配来信 `requestKey`。独立搜索时用新 UUID 加目标 `conversationId` |

群来信的 `recentMessages` 取本条之前的同群发言。绘遇的「手机聊天 · QQ → 每条消息附带的群聊前文」默认 32 条，可选 6、16、32 或 64 条。单独调整条数后，从下一条来信起生效，已有历史和待答来信可继续使用。旧版网关每条附带最多 6 条。需要更早的前文时，可用同群 `context` 读取最近一小时内最多 64 条发言，包括已回复、已跳过的来信和 QQ 已确认的 Muse 回复、主动消息。`eventId` 可用于去重，`author` 区分 `user` 和 `muse`，时间戳为 Unix 毫秒。网关重启后继续使用有效期内的历史。重新保存连接设置或解绑群会开启新的历史记录。

普通群消息需要在绘遇勾选接收并由群主在 QQ 授权。收到的群消息都会带同群稳定的 `senderId`，有昵称时附 `senderNickname`。Muse 可以据此区分发过言的群友。当前来信中的图片通过 `attachments` 提供 QQ 图片链接和类型，每条最多 4 张；远端需打开链接并把图像交给支持识图的模型。群历史只保留附件类型和数量。

排查漏收时，在主力机的 `%APPDATA%\com.aics.studio\desktop.log` 按时间查看 `QQ 入站`。日志里的 `group` 和 `sender` 分别对应会话和发言人编号的前 12 位。同一个 `msg` 可串起分流、过滤原因和入箱记录。入箱后可用 `requestKey` 查到网关首次在收件响应里列出消息、收到 Muse 回信以及取得 QQ 确认的时间。

图片字段格式为 `{"mimeType":"image/png","data":"原图的标准 Base64"}`，支持 JPEG 或静态 PNG，原文件最大 3 MiB。语音使用 `audio: {"mimeType":"audio/mpeg","data":"MP3 原文件的标准 Base64"}`，上限同为 3 MiB（3,145,728 字节，按解码后的字节数计算）。QQ 原生支持 MP3，桥以语音类型上传，取得 QQ 消息回执后返回 `status=sent`。[腾讯 QQ Bot SDK 的直传格式](https://github.com/tencent-connect/qqbot-nodejs/blob/429a0f1b798f3b0fcef3679e207dbc0469a1df2d/src/protocol/utils/audio.ts#L222-L261)

语音 Base64 无效返回 `QQ_MUSE_AUDIO_BASE64`，格式不符返回 `QQ_MUSE_AUDIO_TYPE`，文件超限返回 `QQ_MUSE_AUDIO_SIZE`。整个 JSON 超过传输上限时，直连返回 `QQ_MUSE_BODY_SIZE`，中转返回 `MUSE_BODY_TOO_LARGE`。主动发信的收据在本机保留 24 小时。重试沿用相同编号、目标和内容。遇到 `QQ_MUSE_SEND_UNCERTAIN` 时，原编号可查询已有回执，请先在目标会话核对送达情况。

群友或私聊发「帮我搜一下……」时，绘遇会先搜索，再把原话和来源摘要交给 Muse。支持工具的客户端也可自行选择关键词调用搜索接口，获取标题、链接和摘要。检索词最多 400 字。QQ 对外链另有域名要求，可在回复中引用来源标题和站名。[腾讯发送接口](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)

#### Muse 在 Tailscale 虚拟机上收信

只支持出站连接的虚拟机使用反向轮询。将下面的配置放到绘遇电脑的 `%APPDATA%\com.aics.studio\gateway\muse-qq-vm.json`，把 `localIp` 换成笔记本的 Tailscale IPv4 地址，`vmIp` 换成 Muse 的 Tailscale IPv4 地址。启用至少一种 Muse 对话后，重新保存 QQ 连接或重启绘遇即可生效。移走配置并重新保存 QQ 连接可恢复上一节的中转收信方式。

```json
{"mode":"poll","localIp":"100.64.0.1","vmIp":"100.64.0.2","port":3212}
```

绘遇仅在 `localIp:port` 监听，只接受来自 `vmIp` 的直接 TCP 连接。客户端通过 tailnet 加密链路访问，免密钥。为此接口单独选择可用端口，保留已有的绘图端口 3211。笔记本需要允许 Muse 到该地址和端口的 Tailscale 入站连接。

- Muse 持续请求 `GET http://<localIp>:3212/qq/pending?wait=25`，HTTP 超时至少 40 秒，空结果立即续接。返回的 `items` 是待处理消息，`operations` 是当前接口说明。取题不消费，同一编号只需生成一次回答。有图片的来信会在 `attachments` 列出 QQ 提供的图片地址和 MIME 类型。
- 回答就绪后，向 `POST http://<localIp>:3212/qq/replies` 提交 UTF-8 JSON，格式为 `{"requestKey":"原编号","text":"回复正文"}`。QQ 确认后绘遇返回 HTTP 200 和 `{"ok":true,"requestKey":"原编号","status":"sent"}`，该题随即从待答列表消失。断线或遇到 5xx 时可在到期前用同一编号和原文重试，已确认的回答会返回同一成功回执。
- 正文为 1–1600 字。HTTP 409 表示这条消息已提交过不同的回复，410 表示编号已失效。别把过期回复挂到另一条群消息。旧中转的 QQ 收发接口在此模式下返回 `QQ_MUSE_VM_POLL`。

**回一张图片。** Muse 在同一台笔记本上请求 `POST /qq/replies/{requestKey}/image`，以 JPEG 或静态 PNG 原始字节作为请求体，`Content-Type` 对应为 `image/jpeg` 或 `image/png`，单张上限为 3 MiB。图片接口在 QQ 确认后返回 `{"ok":true,"requestKey":"原编号","status":"sent","kind":"image"}`。

**群里直接要宁宁的照片。** 群友发「@宁宁 发一张宁宁的照片」时，绘遇照常把完整问题交给 Muse，再随她的文字回复附上内置的宁宁窗边喝茶插画。如果 Muse 想发自己的照片，可以在提交文字前先上传原图，绘遇会沿用这张图。普通文字回复也可以单独发 `/发图 宁宁` 主动选择内置图。以上文字接口都沿用原来的 `ok`、`requestKey`、`status` 回执。

图文一起提交时，文字和图片分别记录 QQ 回执。断线后重试原图和原文即可。只回一项时，Muse 仍可在窗口内用同一编号补发另一项。

**兼容主动投递。** 能接受入站连接的虚拟机也可以沿用由绘遇主动连接 Muse 的方式。使用以下配置（省略 `mode` 与 `"mode":"push"` 等价）。

```json
{"localIp":"100.64.0.1","vmIp":"100.64.0.2","port":8765}
```

Muse 服务监听自己的 Tailscale IPv4 地址，放行绘遇的 Tailscale 源地址。两端使用 tailnet 加密链路上的 HTTP，绘遇绑定 `localIp` 发起连接。虚拟机接口不使用绘遇的 `X-Token` 或 QQ 凭据。启用虚拟机投递后，原收件与回复接口返回 HTTP 409 和 `QQ_MUSE_VM_ACTIVE`。群消息只交给配置的虚拟机。

推送给虚拟机的每条消息都包含 `callbackOrigin` 和 `operations`。虚拟机可通过该笔记本地址使用表中的发送、搜索和回复接口，首次主动联系也能直接使用配置中的笔记本地址。原取答接口可返回文字、图片、语音或 `skip`。

**收问题。** 绘遇向虚拟机 `POST /qq/questions` 发送 UTF-8 JSON。Muse 保存问题后立即返回 `202 Accepted`。断线或未收到成功回执时，绘遇会重投相同的请求。请按 `requestKey` 幂等保存，重复提交时也返回成功。若要在绘遇重启后识别 QQ 重放，可另外按 `groupOpenid` 和 `messageId` 去重。

```json
{
  "requestKey": "3c40e968-3ae8-4a24-bc1b-4060b5ce858c",
  "groupOpenid": "QQ_GROUP_OPENID",
  "senderOpenid": "QQ_MEMBER_OPENID",
  "senderNickname": null,
  "senderRole": "member",
  "messageId": "QQ_MESSAGE_ID",
  "text": "帮我想个标题",
  "timestamp": 1700000000000,
  "expiresAt": 1700000300000
}
```

`senderOpenid` 来自 QQ 群事件的 `author.member_openid`，`messageId` 是 QQ 消息 ID，`requestKey` 是这一轮对接号。`text` 已去掉给机器人的提及和 `/muse`。`timestamp` 和 `expiresAt` 均为 Unix 毫秒，QQ 发送时间无法解析时使用绘遇接收时间。虚拟机可在配置中用 `"nicknames":{"群openid":{"成员openid":"已核实的昵称"}}` 补充缺失的昵称。

直连、中转和虚拟机均按 `conversationId` 区分群，按 `senderId` 区分同群发言人；重名或改名后仍按这个 ID 归属消息。`senderNickname` 供称呼，缺失时为 `null`。`senderRole` 优先取 QQ 本条消息的群角色，`owner` 为群主，`admin` 为管理员，`member` 为普通成员。事件缺少角色时，绘遇使用同群同成员最近 5 分钟内的资料，或在 QQ 权限和频率允许时查询。仍缺少依据则返回 `unknown`，Muse 应直接称呼群友。私聊的群角色为 `null`。[群消息字段](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html) · [群成员资料](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_members_member_openid.get.html)

**取回复。** 虚拟机可以在文字写好时直接向问题中 `callbackOrigin` 的 `POST /qq/replies` 回传原 `requestKey` 和 `text`。沿用原有取回复方式时，绘遇收到投递成功回执后，每隔约 3 秒请求同一虚拟机的 `GET /qq/replies/{requestKey}`。未完成返回 `204 No Content`，完成返回 `200 OK` 及下方 JSON，正文为 1–1600 字。若记录丢失，返回 `404` 可让绘遇重新投递原问题。请为同一编号保留同一份结果至 `expiresAt`，允许重复 GET。绘遇用原消息 ID 把答复发回原群，收到 QQ 确认后停止。过期、解绑或停用也会停止。

```json
{"requestKey":"3c40e968-3ae8-4a24-bc1b-4060b5ce858c","text":"可以叫《雨停以前》。"}
```

### Anima 显卡与运行环境

| 设备 | PyTorch 后端 | 配置入口 |
| --- | --- | --- |
| NVIDIA GeForce / RTX / 工作站显卡 | CUDA | 控制室一键准备，或使用兼容的独立 Python |
| AMD Radeon 独显与 Ryzen Radeon 核显 | ROCm / HIP | 安装对应设备和驱动支持的 ROCm PyTorch，在高级设置选择 Anima Python |
| Intel Arc 等受 PyTorch 支持的 Intel GPU | XPU | 安装 Intel XPU PyTorch，在高级设置选择 Anima Python |

AMD 和 Intel 使用高级设置中的「原生计算」加速与「自动」显存策略。保存后重启绘遇，在同一面板执行「检查 Anima 依赖与设备」，确认显示 `AMD ROCm` 或 `Intel XPU`。现有 Anima 完整模型目录可直接使用。显卡、驱动和 Python 版本以 [AMD 兼容矩阵](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityryz/windows/windows_compatibility.html) 与 [PyTorch Intel GPU 指南](https://docs.pytorch.org/docs/2.9/notes/get_start_xpu.html) 为准。

Anima 接受 `torch 2.8.0 / torchvision 0.23.0` 和 `torch 2.9.1 / torchvision 0.24.1` 两组。先在独立环境安装相应 GPU 构建，再从仓库根目录补齐其他固定依赖。下面的 PowerShell 命令保留该环境的 GPU 版 Torch：

```powershell
$animaPython = 'D:\HuiyuAI\inference\rocm\Scripts\python.exe'
$animaPackages = Get-Content tools/inference/requirements.txt | Where-Object { $_ -match '^[a-zA-Z]' -and $_ -notmatch '^torch(vision)?==' }
& $animaPython -m pip install @animaPackages
& $animaPython -I -B tools/inference/worker.py --diagnose
```

多显卡时，启动网关前可设置 `HUIYU_ANIMA_DEVICE=cuda:1` 或 `xpu:1`。ROCm 沿用 PyTorch 的 `cuda:N` 编号。默认使用首个 CUDA/ROCm 设备，其次是首个 XPU 设备。

ROCm 的 Anima 注意力先确认 Flash SDPA 可实际执行，其他形状用 PyTorch 分块计算。ROCm 优先使用经设备运算验证的 BF16，其余设备用 FP32 保留动态范围。自动显存策略在共享显存、Intel XPU、ROCm FP32 和可用显存低于 12 GiB 的 AMD 设备上优先分阶段加载。采样步数在画布与生成栏同步显示，高清修复的两轮分别计数。 [ComfyUI 显卡与注意力选择](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/model_management.py)

Windows 上的 Radeon 880M 在 ROCm 7 和 BF16 模式下会自动合并 Anima 自注意力中的 Q/K 归一化与位置编码，可配合内置 TeaCache 使用。任务元数据的 `nativeRuntime.execution.rocmFusedQkCalls` 记录实际融合次数。设备或输入不匹配时沿用原计算路径。融合会改变少量浮点舍入结果，同种子出图的细节可能不同。

**NVIDIA 受管运行库要求**
- Windows 10 22H2 / 11 x64
- NVIDIA Ampere 至 Blackwell 架构独显（支持 BF16，建议 12 GB 及以上显存）
- 显卡驱动 $\ge$ 572.61，系统内存建议 32 GiB

---

## 2. 应用内离线准备与完整目录导入

若网络受限或已有现成模型，可在控制室展开 **“已有资源与高级设置”** 进行离线接入：

### 离线运行库准备
使用已有 Python 环境与本地 wheelhouse 安装独立运行库：
```powershell
npm run wf -- models:prepare-inference --target-dir "D:\HuiyuAI\inference" --preflight --wheelhouse "D:\wheels"
npm run wf -- models:prepare-inference --target-dir "D:\HuiyuAI\inference" --apply --wheelhouse "D:\wheels"
```

### 完整模型目录导入
将已有的完整 Diffusers 模型目录复制并登记到模型根目录：
```powershell
npm run wf -- models:import-anima-directory --source-dir "D:\models\source-anima" --target-dir "D:\HuiyuAI\inference\models\anima-base-v1.0" --apply
```

---

固定版本模型下载中的 SHA-1 用于重建并核对 Git blob ID，包括绑定 SHA-256 与大小的 Git LFS 指针；实际 LFS 模型字节仍按 SHA-256 校验。它与文件完整性摘要承担不同职责，不因项目同时使用两种摘要就替换 Git 对象算法。

## 3. 架构核验与单文件离线转换

### 检查单文件 Checkpoint 结构
```powershell
python scripts/maintenance/inspect-anima-checkpoint.py --checkpoint "D:\models\miaomiaoHarem_anima16.safetensors"
```

### 经架构核验的离线转换
将单文件 safetensors 严格转换成原生 Diffusers 目录结构（仅在 CPU 执行，不加载张量至 GPU）：

```powershell
python -I scripts/maintenance/convert-anima-checkpoint.py `
  --profile anima-cosmos2b-v041 `
  --checkpoint "D:\models\miaomiaoHarem_anima16.safetensors" `
  --transformer-config "D:\models\config.json" `
  --text-encoder "D:\models\qwen_3_06b_base.safetensors" `
  --vae "D:\models\qwen_image_vae.safetensors" `
  --qwen-tokenizer "D:\models\qwen-tokenizer" `
  --t5-tokenizer "D:\models\t5-tokenizer" `
  --output-dir "D:\HuiyuAI\inference\models\anima-miaomiao-v1.6" `
  --apply
```

**支持的 Profile**：
- `anima-cosmos2b-v041`：28 层、2048 宽度（Anima Base 1.0、MiaoMiao 1.2 / 1.6、Aesthetic 1.1）
- `anima-cosmos29b-v041`：40 层、2048 宽度（MiaoMiao 2.9B Beta 1.1）
- `anima-yume2b-rope-v041`：28 层 Yume 1.0（额外核验静态 RoPE 派生缓冲）

控制室可直接准备 Aesthetic 1.1、MiaoMiao 1.2、MiaoMiao 2.9B Beta 1.1 和 Yume 1.0。已有作者权重可填写本机路径，准备流程会核对文件大小和 SHA-256，再交给对应的转换器。

### 维护同架构模型

- **Anima 单文件**　在绘图目录登记模型后，在对应的下载来源记录上填写 `nativeConversionProfile`。控制室从该字段生成准备选项，复用基础模型的编码器、VAE 和 tokenizer。需要用户自行提供权重的版本可声明 `requiresLocalCheckpoint`。 [绘图目录](../../runtime-rs/src/images/catalog.json) · [下载来源](../../runtime-rs/src/control/setup-models.json)
- **Diffusers 变体**　在适配清单的 `models` 中复用已有 `family`、`pipeline` 和组件布局，填写变体的实际参数。Rust 和 Python 都按 `variantFields` 核对本地索引。例如 Krea 用 `distilled` 区分 RAW 和 Turbo。提供受管下载时，再按同一模型 ID 登记固定版本的文件。 [适配清单](../../tools/inference/adapter-models.json) · [受管下载清单](../../tools/inference/managed-adapter-models.json)

---

## 4. 原生图像与视频模型

原生适配器通过统一的任务队列与内存调度器支持以下模型：

| modelId | 模型来源 | 原生任务入口 | 特性说明 |
|---|---|---|---|
| `krea2-raw` | krea/Krea-2-Raw | `/api/creative/jobs` | 文生图，可调节步数与 CFG |
| `krea2-turbo` | krea/Krea-2-Turbo | `/api/creative/jobs` | 8 步快速蒸馏调度 |
| `qwen-image-2.1` | Qwen/Qwen-Image-2.1 | `/api/qwen/jobs` | 文生图与最多四图参考指令编辑 |
| `qwen-image-2.1-turbo` | Qwen/Qwen-Image-2.1-Turbo | `/api/qwen/jobs` | 8 步文生图与参考图编辑 |
| `moss-miaomiao-base-v1.0` | MIAOKA / OpenMOSS | `/api/moss/jobs` | MiaoMiao MOSS 文生图 |
| `wan2.2-ti2v-5b` | Wan-AI/Wan2.2-TI2V-5B-Diffusers | `/api/video/jobs` | 文字或首帧，3/5 秒，24 fps |
| `wan2.2-14b` | Wan-AI/Wan2.2-T2V-A14B-Diffusers | `/api/video/jobs` | 文字，双噪声阶段，3/5 秒，16 fps |
| `hunyuan-video-1.5` | hunyuanvideo-community/HunyuanVideo-1.5-Diffusers-480p_t2v | `/api/video/jobs` | 文字，480p 版本，3/5 秒，24 fps |
| `minimax-h3` | MiniMaxAI/MiniMax-H3 | `/api/video/jobs` | 文字、首帧或首尾帧，带音轨，5/10 秒档 |
| `ltx-2.3` | diffusers/LTX-2.3-Diffusers | `/api/video/jobs` | 文字或首帧，带音轨，3/5 秒。首帧直接使用解码后的 RGB 图像 |
| `ltx-2.5-distilled` | Lightricks/LTX-2.5-Diffusers | `/api/video/jobs` | 文字或首帧，3/5 秒有声短片。使用 2.5 专用 Gemma 4 文本编码器和单阶段 8 步蒸馏配方 |
| `kandinsky-6-lite-distill` | kandinskylab/Kandinsky-6.0-Lite-distill-5s-Diffusers | `/api/video/jobs` | 文字或首帧，10 步生成 5 秒视频和 44.1 kHz 单声道音轨 |
| `wan-animate-2` | Wan-AI/Wan2.2-Animate-2-14B-Distilled-Diffusers | `/api/video/jobs` | 角色图和 H.264 MP4 动作参考，10 步，3/5 秒无声短片 |
| `longcat-avatar-1.6` | meituan-longcat/LongCat-Video-Avatar-1.6 | `/api/video/jobs` | 角色图和 WAV 配音，8 步，25 fps，3/5 秒单人对白 |

图像适配 Python 与 Anima Python 独立配置。除受管的 PyTorch 2.9 配方外，可复用已有的 PyTorch 2.13.0 / torchvision 0.28.0 / Transformers 5.14.1 / Pillow 12.2.0 / SageAttention 2.2.0 环境；补齐固定版本 Diffusers、Accelerate、PEFT、ftfy 与 huggingface-hub，版本见 `tools/inference/requirements-adapters.txt`。该共享环境的漫画处理使用 NumPy 2.4.4 与 OpenCV headless 5.0.0.93。原生 worker 只使用这些 Python 库，不启动或请求 ComfyUI 服务；切换解释器后重启绘遇，保留 Anima 原配置。

受管模型沿用下载时的完整校验记录，启动只在取得文件保护锁后核对版本、大小与修改状态；不匹配、非受管目录或无法取得保护锁时仍完整读取校验。任务记录的 `modelIdentityScope` 区分准备记录与完整字节摘要，不把二者混称为本次整库校验。

### 原生视频准备与加速

从「故事短片 → 视频引擎设置」选择「本机原生引擎」，准备所选模型，保存并重启绘遇。模型按固定版本下载。LongCat 使用下面的专用环境，其余视频模型使用完整 Diffusers 目录。受管 CUDA 环境面向 NVIDIA。使用 AMD 或 Intel 时，支持该设备的模型可选「仅下载视频模型」，再通过「复用已有环境与模型」填写模型根目录和「图像与视频适配器 Python」。本地 ffmpeg 需有 H.264 编码器，生成音轨还需 AAC。

手动准备时，在单独的 Python 环境安装显卡对应的 BF16 PyTorch。视频适配器支持 torch 2.9.0 / torchvision 0.24.0 和 2.9.1 / 0.24.1。下面的命令使用已有的 GPU 版解释器，从仓库根目录补齐其余依赖，再检查 Wan 5B 的运行环境。

```powershell
$videoPython = 'D:\HuiyuAI\inference\video\Scripts\python.exe'
$videoPackages = Get-Content tools/inference/requirements-adapters.txt | Where-Object { $_ -match '^[a-zA-Z]' -and $_ -notmatch '^torch(vision)?==' }
& $videoPython -m pip install @videoPackages
& $videoPython -I -B tools/inference/adapter_worker.py --diagnose --model-id wan2.2-ti2v-5b
```

「注意力加速」默认自动选择。兼容的 NVIDIA 设备优先尝试本地 FlashAttention 2，其次 SageAttention，其他设备使用 PyTorch SDPA。带遮罩等特殊计算保留 SDPA。ROCm 在大画幅缺少可用融合内核时按查询行分块，保留完整注意力范围。显存设置可选常驻或分层卸载。Wan 和混元可复用文本编码，Wan 的卸载模式会分块解码画面。内核选择和显存需求均与模型、尺寸、帧数有关。 [ComfyUI 注意力实现](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/ldm/modules/attention.py) · [Diffusers 注意力后端](https://huggingface.co/docs/diffusers/optimization/attention_backends)

导出 MP4 时会尝试 NVIDIA NVENC、Windows AMD AMF 或 Intel QSV。硬件编码不可用时，ffmpeg 用 libx264 编码已生成的画面和音轨。已完成任务的 `metadata.nativeRuntime.videoAcceleration` 记录设备、实际调用的注意力内核次数和最终编码器。

在「图片动起来」中选择 Wan-Animate-2 或 LongCat 后，首帧下方会显示对应的素材选择框。Wan 读取动作视频开头的 3 或 5 秒，LongCat 将配音截到所选时长，较短的配音在末尾补静音。接口调用方将文件以 `application/octet-stream` 提交到 `POST /api/video/drivers/video` 或 `POST /api/video/drivers/audio`，再将返回的 `name` 填入生成请求的 `drivingVideo` 或 `drivingAudio`。上传上限为 20 MiB，配音接受 8–192 kHz 的单声道或双声道 PCM WAV。四个新模型按需下载，LTX-2.5 需先在 Hugging Face 接受该版本的许可。 [LTX-2.5 权重](https://huggingface.co/Lightricks/LTX-2.5-Diffusers) · [Wan-Animate-2 权重](https://huggingface.co/Wan-AI/Wan2.2-Animate-2-14B-Distilled-Diffusers)

#### LongCat 专用环境

LongCat 使用支持 BF16 的 NVIDIA 显卡、PyTorch 2.6.0（CUDA 12.4）、torchvision 0.21.0、Triton 3.2 和 FlashAttention 2.7.4.post1。Windows 需使用与 Python、Torch 和 CUDA 匹配的 Triton 和 FlashAttention 构建。把这套环境放在模型根目录旁的 `environments/longcat-avatar`。使用其他位置时，启动绘遇前设置 `HUIYU_LONGCAT_PYTHON` 指向其解释器。

从项目根目录补齐这个环境的依赖并准备官方源码。下面以已装好上述 GPU 依赖的 Windows 环境为例。

```powershell
$avatarEnv = 'D:\HuiyuAI\inference\environments\longcat-avatar'
$avatarPython = Join-Path $avatarEnv 'Scripts\python.exe'
$avatarSource = Join-Path $avatarEnv 'upstream\LongCat-Video'
& $avatarPython -m pip install -r tools/inference/requirements-longcat-avatar.txt
git clone https://github.com/meituan-longcat/LongCat-Video $avatarSource
git -C $avatarSource switch --detach 58eb336edc5c8c63389838727e40b8c18434e54e
& $avatarPython -I -B tools/inference/adapter_worker.py --diagnose --model-id longcat-avatar-1.6
```

已有同一修订的源码时，可通过 `HUIYU_LONGCAT_SOURCE` 指向 checkout 根目录。worker 会校验源码摘要后加载。控制室可先单独下载该模型的 DiT、两套 LoRA、文本编码器、Whisper 和 VAE，共约 63.1 GB。环境准备好后再启用原生视频引擎。 [官方模型卡](https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.6)

---

## 5. MangaScreen 漫画后处理与线稿提取

原生 `/api/manga` 接口提供纯 CPU 高性能漫画网点、色阶与分镜后处理：
- 工作台默认采用上游 QWEN-Manga 流程：Qwen-Image 2.1 Turbo 重绘、自动线稿、250 线网点和原始画幅；按原图比例选择接近 200 万像素的重绘尺寸，使用随机种子。重绘参考图编码与输出按同一像素面积配置，模型未准备时可在面板前往控制室安装。
- **操作类型**：
  - `lite`：色阶调整 + 网点平涂 + 原始画框合成
  - `comic`：线稿强化 + 网点平涂 + 画框裁切
  - `lineart`：仅提取黑线白底线稿（使用独立 MangaLineExtraction 网络）
- **Qwen 指令重绘**：可选在进入后处理前先使用 `qwen-image-2.1-turbo` 将原图重绘为黑白漫画风格。
- **连续调整**：同一原图的明暗、网点、纸张和边框调整沿用最近一次成功重绘的种子；随机模式下点击「换一版重绘」才换新种子。更换原图、重绘模型、指令或尺寸会重新重绘。worker 在文件保护租约有效时保存最近一份重绘 RGB（最多 6 MiB）和自动线稿（最多 8 MiB），输入像素与参数一致才复用；不支持文件保护、租约失效、取消及进程回收时不复用。调色阶改变线稿输入时会重新提取，调网点或纸张可复用线稿。任务记录 `rewrite.resultReused`、`lineart.resultReused` 与 CPU 墙钟分段，分段不可相加。
- **自动线稿**：显存预算足够时使用 CUDA，否则保留 CPU 路径；实际设备写入任务记录。连续重绘复用该 worker 拥有的模型与条件缓存，取消、切换引擎及进程退出时释放。
- 配方版本 5 绑定上述参考图编码规则；旧任务结果可继续查看，旧配方不可按新规则自动重试。新默认流程尚需当前版本的真实画质与设备验收。

---

## 6. 调度、高清精修与 TeaCache

### 调度器与两阶段精修
- **调度器**：支持 Euler 与二阶多步指数积分调度器 RES (`res_multistep`)。
- **两阶段高清**：支持 Latent 二次采样与固定 Remacri 超分辨率放大；支持 RCAS 锐化。

### TeaCache 本机校准与验收
- **日常内置策略**：默认启用基于 Apache-2.0 协议的自适应 TeaCache 策略（默认阈值 0.10，首尾采样步全算保持稳定性），无需针对每个模型/LoRA 单独校准。
- **离线校准命令（维护研究路径）**：
  ```powershell
  python -I scripts/maintenance/calibrate-anima-teacache.py `
    --calibration-job train.json `
    --validation-job heldout.json `
    --output-dir "D:\review" `
    --threshold 0.05 `
    --run
  ```
  在人工审查 review.html 画质与耗时后，通过 `--accept-run` 将校准档案写入模型目录。

---

## 7. 显存策略与进程生命周期

- **显存模式**：
  - Anima 普通生成按需导入可选遮罩模型类，显式诊断仍检查完整依赖；提示词编码关闭未使用的 KV 状态。同一任务按画幅复用最多 16 MiB RoPE，结束或取消即释放。编译模式保留 PyTorch 守卫，首次成功后遇到需要重编译的块在本任务改用普通执行，后续任务仍可尝试已有图；叶级卸载不编译，设备与显存错误继续报错。`nativeRuntime.execution` 记录编码、采样、解码的 CPU 墙钟分段及缓存/编译调用，实际提速与设备效果需另行确认。
  - Anima 的 Sage 系列模式使用已固定的 Triton 3.4.0.post21 接入 Q/K RMSNorm 与 split-half RoPE、LayerNorm 与 scale/shift 融合；参考本机 ComfyUI `b0b7435` 的融合边界，数学和低精度中间舍入按 Diffusers 0.41 实现，不导入 ComfyUI/Kitchen。使用 PyTorch 2.8 的 `triton_op` 接入块编译；不支持的布局保留原计算，`native` 模式不要求 Triton。`execution.kernelBackend` 只说明配置路径，首次 Triton JIT、设备效果和提速尚未验收。Sage 执行修订已更新，旧的显式 TeaCache 校准不能沿用。
  - Anima 使用 `inference.memoryPolicy`，默认 `resident`；Krea、Qwen、MOSS、漫画重绘及原生视频使用 `inference.adapterMemoryPolicy`，默认 `offload`。在控制室分别保存，启用模型保留已有选择；Anima 的 Sage/编译加速不传给其他模型。
  - `resident`（模型常驻）：权重常驻显存，需要显卡能容纳完整模型及运行时激活。
  - `offload`（分阶段卸载）：文本编码器与去噪网络按需搬运，节省显存占用。
  - Qwen/MOSS 的 `offload` 直接映射原权重文件，按当前画幅和空闲显存保留常用层，不生成磁盘权重副本。常驻权重先于临时激活分配；参考图前缀 K/V 可无损保存在 CPU，相同输入的条件编码在模型保护期内复用。条件缓存按最近使用保留最多 8 项、合计不超过 64 MiB，命中的常用负向编码会更新保留顺序。
  - Qwen 2.1 的 `offload` 前缀缓存按分支数、缓存大小及激活余量选择 GPU/CPU，可混合放置。CPU 路径参考 ComfyUI 的同分支逐层预取，最多两个各 256 MiB 的锁页与 GPU 暂存槽；余量不足、层过大或锁页分配不足时使用原同步搬运，不量化 K/V。预取不跨正负分支；最后一步采样后、VAE 解码前释放缓存，取消与失败收妥所属复制流再释放。`nativeRuntime.qwenPrefixCache` 记录位置、容量与实际搬运/预取次数，计数不证明已提速。
  - MOSS 首次编码使用原有阶段预算；已有扩散权重驻留时，后续任务优先保留扩散模型，让文本层共用剩余显存并按需流式搬运。进入采样前将文本权重还原到原 CPU/文件视图，避免两套模型连同采样激活挤满显存后被 Windows 换页；完成后只保留扩散权重，条件编码缓存仍有效。这也适用于原始 BF16 文本编码器；为最大文本组、激活、精度转换及解码预留空间，不能保证任意画幅或外部显存占用下全部常驻。
- **显存释放机制**：
  - 最后一次任务完成后，连续空闲 10 分钟自动释放模型与显存。
  - 启动本地对话或语音时，自动交接显存资源；退出桌面端立即终止子进程。

## 8. MiaoMiao Harem MOSS BASE v1.0 / v1.1

新创作默认选择 `moss-miaomiao-base-v1.1`；1.0 继续保留在模型选择、草稿、任务与作品中，不自动改写历史配方。1.1 INT8 对应作者版本 `3434952`、文件 `3332286`，文件大小 5,413,697,704 字节，SHA-256 `234e8fa8106bf2ac7f83586feb97054cf6e11a23e7cb2c5adfc808031d27b50b`。与 1.0 复用同一固定上游架构、Qwen3.5-9B 编码器、tokenizer、FLUX.2 VAE 与 INT8 算子；1.1 的 168 个投影明确带 `per_row: true`，不含 1.0 的逐层 Kitchen INT8 attention 配置，按版本分别校验元数据并选择既有 Sage/PyTorch 注意力路径。不将 1.1 权重覆盖到 1.0 目录。

已有完整 1.0 时，可运行 `npm run wf -- models:import-moss-int8 --source <作者1.1INT8文件> --model-dir <models根/moss-miaomiao-base-v1.1> --model-id moss-miaomiao-base-v1.1 --reuse-from <models根/moss-miaomiao-base-v1.0>` 预览，追加 `--apply` 写入。路径均用绝对路径，目标模型须未在推理。共享组件核对固定 SHA-256 后优先硬链接，无法链接时复制；主模型校验复制并原子发布导入记录。已有配套 INT8 文本编码器也复用并生成属于 1.1 的记录。保留下载原件与 1.0；文件就绪不代表真实出图与性能验收。

模型 ID 为 `moss-miaomiao-base-v1.0`。从「我的作品 → MiaoMiao MOSS 创作」进入，或在控制室选择该模型准备。先登录[作者版本页](https://civitai.com/models/3015023?modelVersionId=3422319)，下载 `miaomiaoHaremMOSS_baseV10_fp16.safetensors`，在准备面板填写完整本机路径。准备先核对作者 SHA-256 并复制权重，再下载固定版本的 Qwen3.5-9B 编码器、tokenizer 与 FLUX.2 VAE；原文件保留。完整组件约 27.2 GB，另需运行库、缓存及暂存空间，按面板预算准备磁盘。已有完整目录可额外导入同一作者版本的 INT8 文件，复用编码器、tokenizer 与 VAE。

作者 BASE v1.0 INT8（Civitai file `3316568`，5,413,700,574 bytes，SHA-256 `8aa2d469b28ea72beb35730b3a00bf0bffbaca03f0419d6f05d390614fe689d9`）为 Comfy 的逐通道 INT8 ConvRot，分组 256。关闭桌面/原生推理后运行 `npm run wf -- models:import-moss-int8 --source <作者INT8文件> --model-dir <已准备的moss-miaomiao-base-v1.0目录>` 预览，追加 `--apply` 才边复制边核对完整 SHA-256，再发布 `huiyu-moss-int8.json` 导入记录；原下载与 FP16 不覆盖，不复制配套组件。工作文件位于该目录 `transformer/miaomiaoHaremMOSS_baseV10_int8.safetensors`，异常中断留下的未登记文件可在下次导入校验后接续登记。

高级参数「主模型权重」保存 `mossWeightPrecision: auto | fp16 | int8`；默认自动优先使用有效导入的 INT8，未导入时使用 FP16，可显式切回 FP16。INT8 使用已有 `comfy-kitchen==0.2.37` / CUDA 13 Python 运行库的真实 INT8 线性算子，权重和 FP32 scale 以普通参数/缓冲区交给同一显存调度器，不还原整套 BF16 权重；注意力在可用时使用作者标记的 Kitchen INT8 内核，否则沿原有 Sage/PyTorch 路径。当前本机复用 ComfyUI Python；受管 PyTorch 2.9 环境不会被自动升级，缺少可用算子时请使用兼容独立 Python 或选择 FP16。导入、文件就绪与编译均不代表当前真实出图/画质/耗时已验收。

按[作者 BASE v1.0 说明](https://civitai.com/models/3015023?modelVersionId=3422319)，默认使用 Euler、50 步、CFG 3.5、768×1280；其推荐范围为 30–50 步，宽高为 16 的倍数。[OpenMOSS 管线](https://github.com/OpenMOSS/MOSS-Image)的 Shift 固定为 5、负分支跳过第 22 层。模型与 Anima 分别登记，不使用 Anima 编码器、VAE、角色 LoRA 或 TeaCache。

工作台和 Muse 目录共用 MOSS 提示词编译器。普通场景用文字描述角色、衣装、动作和道具。有明确站位、逐格动作或画面文字时，使用中心原点的 `abs_centralized / yxyx` 像素框。三联画会按画幅划分三列，把各格的动作放在对应列。Muse 目录改宽高时按两个轴分别换算。工作台的「编辑布局」也支持带宽高的左上原点 `abs / xyxy` 草稿，手写的绝对坐标在更换画幅后需重新核对。

蓝图明确要求双人同框时，保留该镜头意图。手动选择 POV、单人或裁切镜头会优先使用新取景。双人共用道具的场景仍需在成图中核对两个人的身份、露脸情况和手部归属。

普通描述和手写布局都会合并场景排除项。画面要求出现文字时，自动布局将原文和换行写入文字框，外层指令引号在画面描述中移除。编译器从作者默认负面中去掉 `text` 和 `english text`，并保留用户明确填写的排除词。打开旧任务重画时沿用已保存的最终正负向，切回场景配方后才重新编译。

MOSS 官方管线代码固定到 `OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3`，随产品附 Apache-2.0 许可，不执行模型目录提供的 Python。支持受管 PyTorch 2.9.0 / torchvision 0.24.0 及上面的共享图像运行库；作者 FP16 权重在上传 GPU 时转换为 BF16，不在主机内存复制完整权重。文件就绪和依赖可导入不代表本机画质、耗时或显存验收通过。

「文本编码精度」默认自动。有效的配套 INT8 文本权重优先，也可明确选 BF16、FP8 或 INT8。FP8 只将部分 Linear 权重存为 FP8，计算时恢复 BF16。作品和任务记录实际执行精度，打开历史任务时优先采用其记录的主模型权重。[Diffusers 分层精度转换](https://huggingface.co/docs/diffusers/optimization/memory#layerwise-casting)

`int8` 使用配套的 [Qwen3.5-9B W8A8 ConvRot 编码器](https://huggingface.co/sorryhyun/MOSS-Image-Qwen3.5-9B-int8)，不是主模型 INT8 开关。固定修订 `2e65ae37feace6d47d8fda7c8969da84a9199386` 的 `qwen35_9b_int8_convrot.safetensors` 为 9,873,285,104 bytes，SHA-256 `96064ede0b4caa9b6dd60a9fa868707e7b8ff3ae5347c0bab6bc868b5932f317`。关闭桌面推理后，用 `npm run wf -- models:import-moss-int8 --component text_encoder --source <文件绝对路径> --model-dir <现有MOSS目录> --apply` 校验导入；保留原 BF16 与 tokenizer。248 个校准投影使用同一 Kitchen W8A8 算子，保留文件中的校准归一化及 FP32 scale，不解量化整套权重、不执行模型目录代码。算子要求与主模型 INT8 相同；文件就绪不等于设备验收。

文本编码优先使用已经安装的 FLA DeltaNet 内核。可在已有适配 Python 中安装 `fla-core==0.6.0`、`flash-linear-attention==0.6.0` 与 `einops==0.8.2`，保留现有 PyTorch 及匹配的 Triton（Windows 使用 triton-windows），不让安装器替换运行环境。MOSS 无 KV 状态、无 packed sequence 的提示词编码可复用 FLA 的 Triton causal convolution，无需另编译 Windows `causal-conv1d` 扩展；缺少 FLA 时保留 Transformers 参考路径。FLA/Triton 的首次内核 JIT 仍可能耗时，与下方可选 DiT 编译分开。

MiaoMiao 单文件里的融合 QKV 直接作为一个投影加载，不拆成三个矩阵乘法；原始分离 Q/K/V 目录仍按其结构加载。每个任务单独复用文本细化、RoPE 与同一步正负分支的时间调制，文本/RoPE 缓存合计不超过 64 MiB，结束、取消或失败均释放。Spectrum 预测步跳过文本细化。以上不需要更换作者权重。

「编译推理内核」对应 `mossCompile`：新创作默认关闭并保存在草稿和作品中，已有明确选择保留。只用现有 PyTorch 编译 DiT 块，不编译含 token/chunk Python 循环的 Transformers DeltaNet 参考函数，避免换词长度引发大型图编译。分层调度钩子在编译边界外，只有图像/文本序列轴以 `maybe_mark_dynamic` 提示动态，允许 INT8 算子或图中断后的片段按需要特化，不以强制动态约束拒绝有效图；不启用 CUDA Graph，注意力分发在任务间复用。开启后首次仍可能明显变慢；每块首次成功后使用 PyTorch 的 `fail_on_recompile` 守卫，遇到未命中的输入在本任务改用普通执行并记录 `RecompileSkipped`，后续任务仍可复用原图。叶级卸载不编译 DiT，已知编译器失败退回普通执行，显存不足与设备错误仍正常报错并清理。做法参考 [ComfyUI 的 MOSS 分块编译入口](https://github.com/sorryhyun/ComfyUI-Spectrum-KSampler#ksampler-spectrum-for-moss)与 [PyTorch 编译控制](https://docs.pytorch.org/tutorials/recipes/torch_compiler_set_stance_tutorial.html)，不引入或复制该插件。实际可用性、画质与耗时仍需设备验收。

新建画室与 Muse 目录配方使用 Euler、50 步、CFG 3.5 和「Spectrum · 快速预测」，窗口增长值为 0.5。原生接口省略加速参数时使用完整计算。选择「ER-SDE · 预览」会带入 25 步、CFG 2.5 和完整计算，之后可分别调整。该配方使用 Simple 时间步和独立的种子噪声流，同种子切换采样器会改变构图与细节。[Comfy-Org 的 MOSS Base 配方](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_base_t2i.json) · [ER-SDE 作者实现](https://github.com/QinpengCui/ER-SDE-Solver)

Spectrum 采用 Chebyshev 与一阶 Taylor 混合预测。快速模式的 v3 调度完整计算前 6 步和末 3 步，中间从窗口 2 开始按设定强度增长。加速强度范围 0–2，选 0 仍会预测，选「完整计算」可关闭预测。「Spectrum · 自适应预测」在完整计算的步骤抽查空间和通道，偏差较大就暂停预测，连续两次偏差较小才增长窗口，最多连续预测三次。它记录抽查次数、相对误差和窗口变化。两种模式均在末三步前释放历史特征。成功出图后本地工作进程可复用五分钟，聊天等设备交接仍可提前释放。[Spectrum 原始实现](https://github.com/hanjq17/Spectrum/tree/4e41f91c93ff66b045332530dd7bcb4c60eafbab) · [MOSS 社区调度](https://github.com/sorryhyun/ComfyUI-Spectrum-KSampler/blob/main/moss.py)

原生实现保留最多 6 份图像隐藏状态、4 阶拟合与 0.5 混合权重，避免直接采用社区大历史缓冲的显存开销；因此窗口参数对齐不代表整个预测器与插件逐像素相同。正负分支及跳层组合各自隔离，相同时间点的 CPU 拟合系数在任务内复用，短采样减少或不进行预测。每个任务独立清理，保留取消及进度。显存余量不足、拟合失败或预测出现非有限值时使用完整计算，并在任务 `nativeRuntime.mossAcceleration` 记录窗口配置、实际计算/预测次数、实际最长连续预测及回退原因。不使用 Anima TeaCache 阈值。预测可能改变局部纹理、道具细节与手部关系；收益及画质须依据本机相同参数的逐图记录判断，不能据社区其他模型数据宣称本机提速倍数。

任务 `nativeRuntime.mossExecution` 保留编译入口调用数/退回原因、任务内缓存命中及编码、采样、解码的 CPU 墙钟分段，不额外同步 CUDA；入口调用数不代表整段均已融合或已证明提速。这些分段不是可相加的 GPU 计时，首次编译计入对应分段，`performanceVerified` 始终保持未验证。

MOSS 结果提供独立的 Remacri 1.5×／2× 放大操作，使用现有 `upscale_models/4x_foolhardy_Remacri.safetensors`。只处理已生成的像素副本，不加载 MOSS 权重、不编码提示词、不进行第二轮采样；保留原任务，并可返回原图选择另一倍率。原图每边限 512–1536 像素且为 16 的倍数，输出最大每边 3072 像素。任务保存 `mossUpscaleScale`、`mossUpscaleSourceTaskId` 与实际输出尺寸；运行记录注明 `operation: moss-upscale`、超分权重摘要、分块数及耗时，采样步数为 0。复用 Anima 已有的 FP32 RRDB 4× 网络和重叠拼接，最后 Lanczos 缩至指定倍率；1.5× 并不意味着只执行 1.5× 网络。512 像素块仅在真实 CUDA 显存不足时退到 256／128，保留逐块进度、取消和有限像素检查，不增加额外锐化。放大副本仍可导出或保存到作品册；MOSS 的 Latent 高清重绘尚未接入，Anima 的高清及 TeaCache 设置不变。

## 9. MiaoMiao RealSkin Anima 2.9B 1.0

模型 ID 为 `anima-miaomiao-realskin-2.9b-v1.0`，对应[作者 Anima2.9B 1.0 版本](https://civitai.com/models/2026594?modelVersionId=3415563)。同一发布页还保留旧版 Anima、Illustrious 和 NoobAI，准备时须下载 `miaomiaoRealskin_anima29B10.safetensors`（5,843,203,272 字节，SHA-256 `1e0ad19711045540570dffd5ecc4a39aeeb5810ac2e4641c1d060d47167f4c46`）。该版本需要 Civitai 登录，绘遇不保存该站凭据。

在「控制室 → 原生引擎」选择 RealSkin 并填写权重完整路径。准备先核对作者摘要并复制到工作区，再下载固定版本的 Qwen3-0.6B 编码器、Qwen-Image VAE 和 tokenizer，使用现有 `anima-cosmos29b-v041` 严格转换。转换配置仅将已固定的 Base 配置深度改为 40，全部张量名称、形状和类型仍逐项校验，不将 40 层权重载入 28 层模型；输入和转换后的权重共约 14.6 GB，另需运行库和临时空间。作者原文件保留。

绘制工作台的模型选择与提示词配方独立登记。按该作者版本默认 Euler / SGM Uniform、30 步、CFG 4.0；作者 920×1536 按引擎 16 像素网格调整为 928×1536。质量词使用该版本配方，负面保留作者含义、去重并统一普通标签空格；显式深色或有色皮肤会移除默认 `fair skin`。不声明现有角色 LoRA 兼容，不套用 Harem 1.6、MOSS 或旧版 RealSkin 的参数。当前尚无作者权重的真实加载、编译 Token 与出图证据，保留实验标记，需权重及设备验收。
