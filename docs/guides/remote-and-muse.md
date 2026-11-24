# 远程出图、Muse 助手与手机聊天协议

本指南介绍如何通过 **Cloudflare 中转**、**Tailscale 私网** 或 **专用虚拟机协议** 连接外部 AI 助手（如 Muse）实现远程出图、桌面收信与 QQ 消息收发。

> [!NOTE]
> - 桌面端「另一台绘遇」点对点原生绘图连接见 [独立推理指南](independent-inference.md#在另一台绘遇上使用原生绘图)。
> - 桌宠配置、QQ/微信绑定与微信群卡片见 [桌面陪伴与手机聊天](desktop/companion-dsh-agent-architecture.md) 与 [Muse 微信群卡片](../../tools/muse-wechat-card/README.md)。

---

## 1. 远程出图与素材查询

### 开通与连接

1. 在出图机「控制室 → 绘图与模型 → 原生绘图」开启 **允许连接** 并保存。
2. 在项目根目录运行 Cloudflare Worker 配置脚本并登录个人账号（首次需选定 `workers.dev` 子域名）：
   ```powershell
   .\tools\muse-relay\setup.ps1
   # 仅复制已有 X-Token：
   .\tools\muse-relay\setup.ps1 -CopyToken
   ```
3. 在控制室「Muse 远程出图」查看中转 HTTPS 根地址与 `X-Token`（更换配置后需重启绘遇）。

**接入须知：**
- **请求头**：所有 API 请求均带 `X-Token`，并发送明确应用标识（如 `User-Agent: Huiyu-Muse/1.0`；Cloudflare 会以 `403/1010` 拦截默认 `Python-urllib`）。
- **缓存与限额**　中转原图最多保留 **48 小时**，单张上限 **32 MiB**，总容量 **512 MiB**。空间不足时先清理过期或损坏的记录，再按完成顺序从最早的原图开始淘汰。正在传输且未过期的图片保留原有容量，若仍放不下新图则返回 `storageFull`（HTTP 507）。桌面端任务记录保留约 7 天，本地缓存上限 2 GiB。Cloudflare 免费套餐受官方每日额度限制。

### 核心 API 速查

Muse 和其他助手可以使用同一份 `cli-anything-huiyu`（v1.5.0+）命令行包统一操作绘遇全部远程创作与通道能力（绘图、图生图/蒙版/参考图/MOSS 布局、图像反推、独立放大、短视频与分镜拼接、日语语音、桌面与 QQ 通道、以及只读健康与作品册查询）。HTTPS 中转使用 `HUIYU_CLI_URL` 和 `MUSE_TOKEN`，任务通过 `batchKey` 在助手之间交接。用 `--json errors <batchKey>` 查询生成与交付错误。只支持 HTTP 的助手可直接使用下表的同一套接口。[多助手操作说明](../../tools/cli-anything-huiyu/SKILL.md)

| 用途 | 路径与方法 | 关键参数与说明 |
| --- | --- | --- |
| 接口说明与流转 | `GET /` | 返回 `resultFlow`（轮询地址、下载条件、响应类型） |
| 连通与完整文档 | `GET /api/muse/connection`<br>`GET /api/muse/guide`<br>`GET /api/muse/health` | 查看出图机在线状态、中转存储和连接器能力、完整协议手册或只读全机模块健康摘要 |
| 查询目录与模型 | `GET /api/muse/catalog`<br>`GET /api/muse/options` | 目录支持 `kind`（`media`/`character`/`outfit`/`scene`/`blueprint`）、`search`、`character`、`rating`、`pageSize=500`；`options` 查已装模型（含 `keyframe`/`manga-screen`）、LoRA 与 `standaloneUpscale` |
| 服装详情 | `GET /api/muse/catalog/outfit/{id}` | 如 `/studio/natsume-maid`，返回 `tokens` 与 `compatibleModels` |
| 参考图查重与上传 | `POST /api/muse/inputs/lookup`<br>`POST /api/{family}/images/raw` | 先传 ≤16 个小写 SHA-256 查复用（直连与中转均支持）；未命中再按 `anima`/`creative`/`moss`/`qwen`/`keyframe`/`manga` 原始二进制上传（≤16 MiB，**仅本机/Tailscale 直连支持**；中转场景下反推/放大/视频素材请用各自 Base64 JSON 通道） |
| 提交单张任务 | `POST /api/muse/jobs` | 传目录 `id`、自定义 `prompt`、MOSS `layout` 或 `manga-screen` `initImage` + 新 `requestKey`；支持图生图/蒙版/参考图、`styleLoraId`、加速与高清放大参数 |
| 提交批量任务 | `POST /api/muse/batches` | 传 `ids` 或 `items` 数组（单项 ≤ 8 张，整批 ≤ 16 张）；顶层通用与进阶参数可由单项覆盖 |
| 独立图像放大 | `POST /api/muse/upscale` | `202` 异步批次队列；传 `initImage` 或 `imageBase64`（≤8 MiB）及 `upscaler`（`remacri`/`ultrasharp`）、`scale`（1.1–3.0） |
| 远程图像反推 | `GET /api/muse/interrogate/status`<br>`POST /api/muse/interrogate` | 直连 raw（≤20 MiB）或中转 Base64 JSON（≤8 MiB）；支持 `mode`（`tag`/`caption`）、`threshold`、`assist`、`subjectMode`（`free`/`bound`）、`layout`、`noCache`（默认启用内存+本地 SQLite 14 天结果缓存，仅缓存成功结果，命中返回 `cacheHit: true`） |
| 查询进度 / 取消 | `GET /api/muse/batches/{batchKey}`<br>`DELETE <cancelPath>` | 查看每项 `status`、`progress`、`resultUrl`；取消整批或单张 |
| 队列与恢复 | `GET /api/muse/queue`<br>`GET /api/muse/jobs` | 查排队；按 `since` / `nextBefore` / `agent` / `status` 找回近期单图或批次 |

- **目录默认配方**：支持 `anima-miaomiao-v1.6`（默认）、`moss-miaomiao-base-v1.0`、`moss-miaomiao-base-v1.1` 及 `krea2-turbo` / `krea2-raw`（动态编译英文自然语言配方并支持 `styleLoraId`，以本机已安装版本为准）。
- **进阶图像控制**：Anima 支持 `initImage`、`denoisingStrength`、`maskImage`/`maskPrompt`、`maskThreshold`、`growMaskBy`、`sketchControl`、`regions`；`qwen-image` 与 `keyframe`（`flux-kontext-dev`/`minimax-h3-image-q4`）支持 `initImage` + ≤3 张 `referenceImages`；`manga-screen` 支持 `initImage` + `operation`/`penLines` 等漫画网点参数；MOSS 支持直接传 `layout` 对象（自动换算 `assistLayout`/归一化 `0..1`/`rel_1000`/`xyxy` 为规范中心像素框）。
- **Anima 高清放大与独立放大**：生图内联放大传 `"upscale": "ultrasharp" | "remacri" | "off"`；对已有图片放大调用 `POST /api/muse/upscale`（或 `cli-anything-huiyu upscale`），`remacri` 1.5×/2.0× 走原生纯像素通道，`ultrasharp` 走 Anima 放大重绘。

`GET /api/muse/connection` 保留 `laptopOnline` 和 `lastSeenAt` 等连接字段。新版中转返回 `storage.usedBytes` 和 `storage.maxBytes`（字节）、`storage.readyFiles` 和 `storage.transferringFiles`（未过期张数）以及 `storage.oldestExpiresAt`（最早的未过期记录，Unix 毫秒，无记录时为 `null`）。`usedBytes` 包含已暂存和正在传输的原图所占容量。`capabilities.voice` 和 `capabilities.modelRead` 表示连接器最近上报的语音和模型查询支持情况。旧中转可能省略这两个对象。

桌面端可在「Muse 远程出图」下点「检查中转状态」，共享 CLI 可用 `status` 或 `doctor` 查看相同信息。

### 自动收图、校验与 CLI

1. **按 `items[].next` 推进**：
   - `accept` 为 `application/json` 时按 `retryAfterSeconds`（默认 2s）查批次 `statusPath`；`next` 为 `null` 时按 `status`、`deliveryStatus` 与 `error` 结束（常见终止：`expired`、`storageFull`、`invalidReceipt`、`integrityError`）。
   - `resultAvailable` 为 `true` 且 `next.accept` 为 `image/png` 时下载 `resultUrl`。
2. **并行、续传与完整性校验**：
   - 原图 ≥ 1 MiB 时可按 `next.ranges` 发起 4 路 `Range` 并发（校验 `206` 的 `Content-Range`/`Content-Length`）或直接单路 `200` 下载。
   - 保存前校验 PNG 文件头（`89504e470d0a1a0a`）、`resultBytes` 与 `resultSha256`。
   - 断线续传可带 `Range: bytes=N-` 与 `If-Range: <ETag>`；弱网可按 `resultUrl?part=0` 逐片拉取 128 KiB 分片并核对 `X-Part-Sha256` 与 `X-Result-Offset`。
3. **长轮询 `receivePath`**：支持直接向 `receivePath` 发起最长 20s 的 `GET` 等待；收到 `202` 或含 `"pending":true` 的 JSON 时按 `Retry-After`（默认 2s）续查。`deliveryStatus=transferring` 表示中转正在收图，`ready` 表示可离线下载。
4. **命令行工具（Python 3.11+）**：
   ```powershell
   # 取已有批次结果（密钥交互输入或设 MUSE_TOKEN 环境变量）
   py tools/muse-relay/get_result.py <HTTPS地址> <batchKey> 成图.png [--item 2] [--single-connection]

   # 一条命令提交并等待保存原图
   py tools/muse-relay/get_result.py <HTTPS地址> '@request.json' 成图.png --submit
   ```

---

## 2. 桌面角色聊天收信

在「角色聊天 → 聊天设置 → 聊天模型」选择 **Muse**，点击「复制给 Muse 的收信说明」交给正在连接的助手（使用 Cloudflare 需先更新 Worker；设置页会显示最近 90 秒内是否收到收信请求）。

| 连接方式 | 拉取桌面来信 | 回传角色回复 |
| --- | --- | --- |
| 远程绘图端口 / Cloudflare（带 `X-Token`） | `GET /api/muse/desktop/inbox?wait=25` | `POST /api/muse/desktop/reply` |
| Tailscale 虚拟机专用端口 | `GET /desktop/pending?wait=25` | `POST /desktop/replies` |

- **长轮询**：`wait` 上限 30 秒（或使用请求头 `Prefer: wait=20`），HTTP 超时设为 ≥ 40 秒；空队列返回即续接（旧网关无 `inboxWaitSeconds` 时等 2 秒）。
- **回复规则**：按 `conversationId` 区分上下文，在 `expiresAt` 前提交 `{"requestKey":"来信编号","text":"角色回答"}`。重试沿用原编号和完整回复。
- **角色回图**：在聊天设置的「更多选项」开启「房间工具」，并启用本机原生绘图。用户提出出图需求且来信的 `drawingAllowed` 为 `true` 时，Muse 可随同文字附上 `drawing`。例如 `{"requestKey":"来信编号","text":"好呀，等我拍一张。","drawing":{"ids":["目录场景 ID"]}}`。也可使用远程批次支持的 `items`。绘遇提交这批图，进度和成图都会显示在原对话的出图卡里。

---

## 3. QQ 群与私聊收发（Muse 协作）

在「服务与连接 → 手机聊天 · QQ」绑定机器人并勾选交给 Muse 的会话。可按需开启「接收非 @ 群消息」（需在 QQ 给机器人开全群消息权限）与「允许 Muse 主动发消息」。绑定、`/帮助`、`/取图` 等指令仍由绘遇本地处理。

### 收发约束与上下文

- **容量与窗口**：文字限 **1600 字**；群回复窗口 **5 分钟**，私聊 **60 分钟**（`expiresAt` 为 Unix 毫秒，重启或重新绑定后失效）；单条来信最多附 4 张图片链接。
- **上下文前文**：群聊 `recentMessages` 默认附带前 **32 条**（可选 6/16/32/64）；私聊最多附带最近 1 小时内 **6 条**（仅内存保存，重连清零）。
- **持续收信**：请求 `GET /api/muse/qq/inbox?wait=25`（HTTP 超时 ≥ 40 秒），`ambient: true` 表示非 @ 普通群消息，跳过可提交 `{"requestKey":"编号","skip":true}`。

### 通用接口对照

| 操作 | 直连 / Cloudflare | Tailscale VM 端口 | 请求要点 |
| --- | --- | --- | --- |
| 查目标会话 | `GET /api/muse/qq/targets` | `GET /qq/targets` | 获取 `conversationId` |
| 查群上下文 | `GET /api/muse/qq/context/{conversationId}` | `GET /qq/context/{conversationId}` | 最近 1 小时最多 64 条（`eventId` 去重） |
| 回复来信 | `POST /api/muse/qq/reply` | `POST /qq/replies` | `requestKey` + `text`（可加 `mentionSenderId`）和/或附件 |
| 主动发消息 | `POST /api/muse/qq/send` | `POST /qq/send` | 新 UUID `requestKey` + `conversationId` + `text`/`image`/`audio` |
| 搜公开网页 | `POST /api/muse/qq/search` | `POST /qq/search` | `query`（≤ 400 字）配 `requestKey` 或独立目标会话 |

- **媒体附件格式**：支持 `image/jpeg`、`image/png` 与 `audio/mpeg`（MP3），Base64 解码后均上限 **3 MiB**（3,145,728 字节）。
  - 图片：`{"mimeType":"image/png","data":"<Base64>"}`
  - 语音：`audio: {"mimeType":"audio/mpeg","data":"<Base64>"}`
  - 常见错误码：`QQ_MUSE_AUDIO_BASE64`、`QQ_MUSE_AUDIO_TYPE`、`QQ_MUSE_AUDIO_SIZE`、`QQ_MUSE_BODY_SIZE`、`MUSE_BODY_TOO_LARGE`、`QQ_MUSE_SEND_UNCERTAIN`（重试前先核对目标会话）。
- **漏收排查**：在主力机 `%APPDATA%\com.aics.studio\desktop.log` 搜索 `QQ 入站`，用 `group`、`sender`、`msg` 与 `requestKey` 串联日志。

---

## 4. Tailscale 虚拟机专用模式

绘遇使用 `%APPDATA%\com.aics.studio\gateway\muse-qq-vm.json` 中的 `localIp`、`vmIp` 和 `port` 提供桌面收信。已有文件可直接沿用，即使关闭 QQ 机器人，Muse 也能用同一地址访问 `/desktop/pending` 和 `/desktop/replies`。两端通过 Tailscale IPv4 HTTP 通信，绘遇只接受配置的 `vmIp`，无需 `X-Token`。

继续使用旧 QQ 机器人时，修改本文件后保存 QQ 连接或重启绘遇，以更新 QQ 转发配置。`mode` 决定旧 QQ 机器人的转发方式。移走文件可恢复中转模式。

### 模式 A：反向轮询（`mode: "poll"`，推荐仅出站 VM）

```json
{"mode":"poll","localIp":"100.64.0.1","vmIp":"100.64.0.2","port":3212}
```

- 绘遇仅向 `vmIp` 监听 `localIp:3212`（与绘图端口 3211 隔离）。
- **拉题**：`GET http://<localIp>:3212/qq/pending?wait=25`。
- **回文**：`POST http://<localIp>:3212/qq/replies` 提交 `{"requestKey","text"}`（冲突报 409，过期报 410；旧中转接口报 `QQ_MUSE_VM_POLL`）。
- **回图**：`POST /qq/replies/{requestKey}/image` 直接发送 JPEG/PNG 原始字节（≤ 3 MiB）。群内发 `/发图 宁宁` 或「发一张宁宁的照片」可附带或沿用上传图片。

### 模式 B：主动投递（`mode: "push"`，省略 `mode` 时默认）

```json
{"localIp":"100.64.0.1","vmIp":"100.64.0.2","port":8765}
```

- 绘遇向 VM 发送 `POST /qq/questions`（包含 `requestKey`、`groupOpenid`、`senderOpenid`、`senderNickname`、`senderRole`、`messageId`、`text`、`timestamp`、`expiresAt` 及 `callbackOrigin`/`operations`），VM 应立即幂等返回 `202 Accepted`（缺失昵称可在配置中用 `nicknames` 字典补充）。
- 回复可由 VM 主动回调 `callbackOrigin` 的 `POST /qq/replies`，或由绘遇每 3 秒轮询 VM 的 `GET /qq/replies/{requestKey}`（`204` 等待、`200` 取回、`404` 触发重投）。启用期间旧收发接口返回 `409 QQ_MUSE_VM_ACTIVE`。

---

## 5. 远程短视频、语音合成与只读作品册

均通过同一 `X-Token` 认证并支持 `cli-anything-huiyu` 命令行直接操作（直连走原始二进制/Range，HTTPS 中转自动切换 Base64 上传与 `?part=N&count=M` 分片下载并校验 SHA-256）。

### 短视频生成与分镜拼接（`/api/muse/video/*`）

| 操作 | 路径与方法 | 说明 |
| --- | --- | --- |
| 查询状态与模型 | `GET /api/muse/video/status` | 可选 `?modelId=`；返回 `minimax-h3`（含 `h3Dwd`/`h3LightVae`）、`wan2.2-*`、`ltx-*` 等模型与限额 |
| 提示词预览 | `POST /api/muse/video/prompt/preview` | 返回编译后的 `prompt` / `negative` |
| 上传输入素材 | `POST /api/muse/video/inputs` | 直连 `application/octet-stream` + `?kind=`（≤20 MiB）；中转 `application/json` `{kind,mimeType,data}`（Base64 解码 ≤3 MiB） |
| 单任务管理 | `POST /api/muse/video/jobs`<br>`GET`/`DELETE` `/api/muse/video/jobs/{id}`<br>`GET`/`DELETE` `/api/muse/video/requests/{key}` | 提交（必填 `requestKey`）、查询、取消；就绪后提供 `resultUrl`/`resultBytes`/`resultSha256` |
| 分镜批次与拼接 | `POST /api/muse/video/batches`<br>`GET`/`DELETE` `/api/muse/video/batches/{id}`<br>`POST /api/muse/video/batches/{id}/concat`<br>`POST /api/muse/video/batches/{id}/retry` | 批量分镜（Body ≤1 MiB）、拼接成片、按 1-based `indices` 重试失败分镜 |
| 校验下载成片 | `GET`/`HEAD` `/api/muse/video/jobs/{id}/result`<br>`GET`/`HEAD` `/api/muse/video/batches/{id}/result` | 直连支持 `Range` + `If-Range`；中转支持 `?part=N&count=M`（128 KiB/片，每次 1–16 片）并核对 `X-Part-Sha256` / `X-Result-Sha256` |

### 远程日语语音（`/api/muse/voice/*`）

| 操作 | 路径与方法 | 说明 |
| --- | --- | --- |
| 查询语音状态 | `GET /api/muse/voice/status` | 返回引擎、声线（`nene`/`natsume`）与支持格式 |
| 合成日语语音 | `POST /api/muse/voice/synthesize` | 传 `requestKey`、日语 `text`（1–500 字）及可选 `voice`/`emotion`/`referenceEmotion`/`consistency`/`speed`/`format`（`mp3`/`wav`），返回 Base64 `data` + `bytes` + `sha256` |

### 只读健康检查与桌面作品册（`/api/muse/health`、`/api/muse/gallery*`）

严格只读，绝不暴露本机绝对路径、密钥、Token 或写删接口：

| 操作 | 路径与方法 | 说明 |
| --- | --- | --- |
| 主机健康摘要 | `GET /api/muse/health` | 返回 `inference`、`modules`（图像/视频/反推/语音/QQ/桌面）、模型计数、作品数量与 `capabilities` 开关 |
| 分页浏览作品册 | `GET /api/muse/gallery` | 支持 `page`（1–200）、`pageSize`（1–50）、`kind`（`all`/`image`/`video`/`audio`）、`character`、`search`、`favorite`、`tag`、`engine`、`model`、`reviewState` |
| 作品详情与原文件 | `GET /api/muse/gallery/{id}`<br>`GET`/`HEAD` `/api/muse/gallery/{id}/file` | 可选 `?idType=string|number`；下载支持直连 `Range` 与中转 `?part=N&count=M` 分片及 SHA-256 校验 |
