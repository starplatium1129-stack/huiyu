---
name: cli-anything-huiyu
description: 为 Muse 和其他智能体操作同一台绘遇桌面主机。支持本机、Tailscale 和 HTTPS 中转，统一覆盖绘图（含图生图/参考图/蒙版/构图/keyframe/manga/Krea 2/MOSS 布局）、独立放大、图像反推、短视频生成与分镜拼接、日语语音合成、桌面与 QQ 消息通道、以及只读健康与作品册查询归档。
---

# 操作绘遇桌面全功能 CLI

Windows 安装包的入口是安装目录下的 `gateway\tools\cli-anything-huiyu\cli-anything-huiyu.exe`。将该目录加入当前终端的 PATH 后，可以直接使用下列命令。源码入口是 `node tools/cli-anything-huiyu/cli.mjs`，需要从任意目录调用时也可以在仓库根目录运行 `npm install --global ./tools/cli-anything-huiyu`。

在另一台助手主机上，将命令行包复制过去，用 Node.js 22.18 或以上版本运行 `npm install --global ./cli-anything-huiyu-1.8.1.tgz`。安装后运行 `cli-anything-huiyu --json help`，即可读取本机可用命令和本说明文件的位置。

## 接到聊天模型（`invoke`）

项目聊天、桌宠和 QQ 使用支持工具调用的模型时，绘遇会注册 `huiyu_drawing`。外部 Muse 或其他模型客户端可以从 `cli-anything-huiyu --json help invoke` 返回的 `commands.invoke.tool` 注册相同的函数。调用时把模型的参数对象编码成 UTF-8 JSON，送入 `cli-anything-huiyu --json invoke` 的标准输入，读取本次进程的成功或错误回执。

```powershell
'{"action":"status"}' | cli-anything-huiyu --json invoke
```

- `invoke` 除既有绘图操作（`status`、`key`、`catalog`、`detail`、`models`、`draw`、`draw_preview`、`batch`、`queue`、`recent`、`job`、`errors`、`cancel`、`save`）外，还支持 `health`、`upscale`、`interrogate_status`、`interrogate`、`voice_status`、`voice_say`、`video_status`、`video_preview`、`video_create`、`video_job`、`video_cancel`、`video_batch`、`video_concat`、`gallery_list`、`gallery_show`。
- **群聊安全隔离**：设置 `HUIYU_CLI_SCOPE` 时保留 `draw_preview` 等只读配方功能。任务操作仍限本群当前发起人前缀（`<scope>_`）名下的绘图与独立放大任务。全机队列、历史、归档、`health`、`gallery_*`、`interrogate*`、`voice_*`、`video_*` 均默认拒绝（`DRAWING_SCOPE_DENIED`）。
- 要交给另一位助手接手，先用 `{"action":"key"}` 获取编号，提交时在 `batchKey` 中原样传入。内置工具的 `save` 将 PNG 存入桌面运行目录的 `agent-drawings`；外部工具进程可用 `HUIYU_CLI_OUTPUT_DIR` 指定归档目录，默认使用当前目录。聊天中的大回执会标记 `truncated`，可缩小分页或用对应的只读子命令查看全量。

## 连接配置

各助手连接同一台绘遇主机即可共享队列和回执。桌面端需开启「允许其他绘遇连接本机绘图」并在首次保存后重启。

| 助手位置 | 地址 | 凭据环境变量 |
| --- | --- | --- |
| 出图机本机 | 默认 `http://127.0.0.1:3211`，自定义端口用 `HUIYU_CLI_PORT` | `HUIYU_CLI_TOKEN`，来自原生绘图设置 |
| Tailscale 对端 | `HUIYU_CLI_URL=http://<出图机的 Tailscale IPv4>:<转发端口>` | `HUIYU_CLI_TOKEN` |
| Muse HTTPS 中转 | `HUIYU_CLI_URL=https://<已配置的中转域名>` | `MUSE_TOKEN`，使用中转的 X-Token |

可选环境变量 `HUIYU_CLI_AGENT`（如 `muse` 或 `codex`）会为新生成的 `requestKey` 加上助手名前缀；显式传入的编号会原样保留。

## 诊断、目录与基础绘图

```powershell
cli-anything-huiyu --json status
cli-anything-huiyu --json doctor
cli-anything-huiyu --json health
cli-anything-huiyu --json models --model anima-miaomiao-v1.6 --character nene
cli-anything-huiyu --json catalog --kind scene --character nene --page-size 5
cli-anything-huiyu --json detail scene <目录ID>
cli-anything-huiyu --json key
cli-anything-huiyu --json draw --id <目录ID> --key <requestKey> --out .\成图.png
cli-anything-huiyu --json batch --ids sc041,sc093 --out-dir .\成图 --timeout 600
cli-anything-huiyu --json wait <batchKey> --item 2 --timeout 300
cli-anything-huiyu --json save <batchKey> .\成图 --all
```

- `doctor` 检查连接、凭据格式、协议版本、中转存储及全部新能力开关（兼容老版本出图机与中转）；`health` 返回只读主机模块在线状态、模型数量和推理引擎摘要。
- `models` 返回所有已安装图像模型（含 `anima`、`moss-image`、`qwen-image`、`krea2`、`keyframe`、`manga-screen`）及其 `img2img`/`mask`/`maxReferenceImages`/`mossLayout`/`multiCast` 与 `standaloneUpscale` 能力。
- 目录出图支持 `--kind scene|blueprint|outfit|prompt|manga`、同角色 `--outfit` 换装、Krea 2 目录动态编译及 `--style-lora`。Anima 加速用 `--tea-cache on|off` 与 `--tea-cache-thresh 0–1`；MOSS 加速用 `--moss-sampler euler|er-sde`、`--moss-acceleration off|spectrum|spectrum-adaptive`、`--moss-spectrum-flex-window 0–2`。
- **1–5 人多角色混搭同框**：重复传 `--cast 角色ID[:服装ID|=自定义服装|none][:动作]`，也可用 `--cast-file JSON`。目录角色可用 ID、名称或唯一别名。原创成员用对象表示，例如 `{"characterId":"oc","name":"Mira","appearance":"short copper hair, green eyes","gender":"girl"}`。可省略 `characterId` 或写 `custom`、`original`、`oc`，称呼（最多 80 字）和外貌（最多 400 字）至少填一项，`gender` 可用 `girl`、`boy`、`other`，默认 `girl`。
  - **自定义服装 / 睡衣 / 剧情装**：在对象中传 `outfitPrompt`（或在 CLI 简写用 `=自定义服装` 如 `--cast "nene:=cream knit pajamas, fluffy socks:curled up smiling"`），或传 `outfitId: "none"` 清空官方默认服，完全不会被默认校服/制服覆盖。
  - **角色间细致互动 & 亲密站位**：用 `--interaction`（JSON 中 `interaction`，支持字符串或数组，≤1000 字）描述对视、牵手、共用一把伞/杯子等关系；每个成员 `action` 支持最多 600 字细节；`--formation` 支持 `row|close|staggered`（2–3 人带 `interaction` 时自动默认 `close` 亲密重叠构图；MOSS 还支持在成员对象传 0..1 归一化 `bbox: [y1, x1, y2, x2]` 自由叠框）。
  - **防多画人原则**：所有角色穿搭和个人细节放进各自 `cast` 成员，互动关系放 `interaction`，顶层 `--prompt` 只写共同场景、背景、光影和镜头，不要在 `--prompt` 里按左右位置把人物重新写一遍。
```powershell
cli-anything-huiyu --json draw --model moss-miaomiao-base-v1.1 --cast "nene:=cream knit pajamas, fluffy socks:leaning right and smiling softly" --cast "natsume:=oversized navy hoodie:holding a warm mug" --interaction "Nene leans close to Natsume on the sofa, both sharing one mug and looking warmly at each other" --prompt "cozy living room at night, warm lamp light" --out .\duo.png
cli-anything-huiyu --json draw --model moss-miaomiao-base-v1.1 --cast nene --cast frieren --from-interrogate .\layout.json --out .\ref-duo.png
cli-anything-huiyu --json draw --model anima-miaomiao-v1.6 --id sc093 --cast "nene:none:wearing summer yukata, smiling" --cast "natsume:=pale blue yukata:holding a paper fan" --interaction "both girls walking shoulder to shoulder smiling at each other" --out .\scene-duo.png
cli-anything-huiyu --json draw --model anima-miaomiao-v1.6 --cast-file .\cast.json --from-interrogate .\reference.json --dry-run
```
- `draw --dry-run` 或 `invoke` 的 `{"action":"draw_preview","params":{...}}` 只编译单图配方并返回模型、画幅、正向和负向提示词。也可用 `{"action":"draw","params":{"dryRun":true,...}}`。预览省略任务编号、等待和输出选项，图片参数使用已上传的文件名。
- `--from-interrogate` 搭配 `--cast` 会单独传递参考词条和描述，由服务器过滤参考原人物的身份、外貌与服装。MOSS 还可用参考布局和对应框的局部服装。手写的 `--prompt` 可与参考层一起使用。
- `queue` 查队列，`recent --agent muse --status failed` 查历史，`errors <batchKey>` 或 `errors --agent muse` 排错，`cancel <batchKey> [--item 序号]` 取消任务。加 `--compact` 可精简 JSON 回执。

## 参考图上传、图生图、反推与独立放大

```powershell
# 上传参考图（先按 SHA-256 查复用，未命中再上传到对应模型族）
cli-anything-huiyu --json upload .\ref.png --family anima

# 图生图 / 局部重绘 / 多参考图 / keyframe / manga-screen
cli-anything-huiyu --json draw --prompt "1girl, window tea" --init-image .\base.png --denoise 0.65 --out .\i2i.png
cli-anything-huiyu --json draw --model qwen-image-2.1 --prompt "change dress to sailor uniform" --init-image .\base.png --ref .\dress.png --out .\edit.png
cli-anything-huiyu --json draw --model flux-kontext-dev --prompt "cinematic lighting" --init-image .\frame.png --out .\kf.png
cli-anything-huiyu --json draw --kind manga --model manga-screen --init-image .\cg.png --operation lite --out .\manga.png

# 远程图像反推（直连走 raw ≤20 MiB，中转自动切 Base64 JSON ≤8 MiB；默认命中服务端持久化结果缓存，加 --no-cache 强制重算）
cli-anything-huiyu --json interrogate status
cli-anything-huiyu --json interrogate .\sample.png --assist --subject-mode free --layout --out-json .\layout.json

# 用反推结果直接衔接 MOSS / Krea 2 / Anima 出图
cli-anything-huiyu --json draw --model moss-miaomiao-base-v1.1 --from-interrogate .\layout.json --width 1024 --height 1024 --out .\moss.png
cli-anything-huiyu --json draw --model moss-miaomiao-base-v1.1 --prompt "window tea scene" --layout-file .\layout.json --out .\moss2.png

# 独立图像放大（Remacri 纯像素放大或 UltraSharp 放大重绘）
cli-anything-huiyu --json upscale .\sample.png --upscaler remacri --scale 1.5 --out .\up.png
cli-anything-huiyu --json upscale --image-id <uploadedName> --upscaler ultrasharp --scale 1.5 --wait
```

- `draw` / `batch` 的 `--init-image`、`--mask`、`--ref`（可多次传入）、`--pen-lines` 同时接受服务器已上传文件名（`aics_anima_input_*`）或本地图片路径（自动 SHA-256 查复用或上传）。**注意中转边界**：HTTPS 中转仅放行 `POST /api/muse/inputs/lookup` 复用已缓存参考图，上传新参考图（`POST /api/{family}/images/raw`）需使用本机或 Tailscale 直连；经中转使用图像反推、独立放大与视频素材上传请直接调用 `interrogate`、`upscale`、`video upload` 的 Base64 JSON 通道。
- 额外支持 `--mask-prompt`、`--mask-threshold`（0.05–0.95）、`--grow-mask-by`（0–32）、`--sketch-file`、`--regions-file`。
- `draw --layout-file` 自动识别纯布局 JSON 或 `interrogate --layout --out-json` 产出的 `assistLayout`；后端自动将 `0..1` / `rel_1000` / `xyxy` 坐标换算为 MOSS 规范中心像素框。

## 远程短视频与分镜拼接（`video`）

```powershell
cli-anything-huiyu --json video status
cli-anything-huiyu --json video preview --model minimax-h3 --duration 5 --prompt "girl smiling by the window"
cli-anything-huiyu --json video upload .\first.png --kind image
cli-anything-huiyu --json video create --model minimax-h3 --image-file .\first.png --duration 5 --prompt "gentle breeze" --out .\clip.mp4
# 已配置原生 H3 并导入 pi-H3 DWD 加速包
cli-anything-huiyu --json video create --model minimax-h3 --duration 5 --steps 2 --h3-decoder dwd --video-attention auto --prompt "gentle breeze" --out .\dwd.mp4
# 原生 Wan A14B 图生视频，使用 720p 和本机已准备的四步配方
cli-anything-huiyu --json video create --model wan2.2-i2v-a14b-gguf --image-file .\first.png --duration 5 --wan-resolution 720 --steps 4 --prompt "gentle breeze" --out .\wan.mp4
cli-anything-huiyu --json video job <id或requestKey>
cli-anything-huiyu --json video wait <id或requestKey> --timeout 1800
cli-anything-huiyu --json video save <id或requestKey> .\clip.mp4
cli-anything-huiyu --json video batch .\storyboard.json --wait --concat --out .\movie.mp4
cli-anything-huiyu --json video retry <batchId> --shots 2,4 --wait
cli-anything-huiyu --json video concat <batchId> --out .\movie.mp4
cli-anything-huiyu --json video cancel <id或requestKey> [--batch]
```

- `video upload` 支持 `image` / `first-frame` / `last-frame` / `studio-frame` / `reference`（PNG/JPEG/WebP）、`driving-video`（MP4）、`driving-audio` / `studio-audio`（PCM WAV）。直连走 raw（≤20 MiB），HTTPS 中转自动切 Base64 JSON（≤3 MiB）。
- `video create --steps` 接收正整数，取值由当前模型和已安装权重决定。MiniMax H3 Turbo 支持已安装的 4 或 8 步配方。
- `--h3-decoder dwd|lightvae|original` 选择原生 H3 解码器。pi-H3 两步使用 `--steps 2 --h3-decoder dwd`，并要求出图机已导入通过校验的 DWD 权重。LightVAE 也需要安装相应的解码器。
- `--video-attention auto|sdpa|sage|flash2` 由原生模型及本机内核决定兼容性。H3 另提供 `h3-sol`、`h3-sla` 与 `h3-fused`。两步 DWD 支持 `auto` 和兼容的普通注意力或 Sol。SLA 与 Fused 各需四步及对应权重。
- `--wan-resolution 480|720` 用于原生 `wan2.2-i2v-a14b-gguf` 图生视频，默认 480p，须提供首帧。通过 `--file` 或分镜 JSON 传入对应字段时，`steps`、`wanResolution` 使用数字，`h3Decoder`、`videoAttention` 使用字符串。
- `video save` / `video create --out` / `video concat --out` 在直连下使用 Range 校验下载，在中转下自动切 `?part=N&count=M` 分片校验下载，全程核对 SHA-256。

## 远程日语语音（`voice`）

```powershell
cli-anything-huiyu --json voice status
cli-anything-huiyu --json voice say "おかえりなさい、今日も頑張ったね。" --voice nene --emotion gentle --format mp3 --out .\nene.mp3
```

- 支持 `--voice nene|natsume`、`--emotion` / `--reference-emotion`（`neutral|gentle|happy|shy|serious|sad`）、`--consistency locked|adaptive`、`--speed`（0.25–4.0）、`--format mp3|wav`、`--key`、`--out`。自动校验 `bytes` 与 `sha256` 后解码保存。

## 桌面聊天与 QQ 通道（`desktop` / `qq`）

```powershell
# 桌面聊天收发
cli-anything-huiyu --json desktop inbox --wait 25
cli-anything-huiyu --json desktop reply <requestKey> "好呀，等我画一张给你。" --drawing-ids sc093

# QQ 群 / 私聊收发与联网搜索
cli-anything-huiyu --json qq inbox --wait 25
cli-anything-huiyu --json qq targets
cli-anything-huiyu --json qq context <conversationId>
cli-anything-huiyu --json qq reply <requestKey> --text "收到啦！" --image .\card.png --mention <senderId>
cli-anything-huiyu --json qq reply <requestKey> --skip
cli-anything-huiyu --json qq send <conversationId> --text "早安！"
cli-anything-huiyu --json qq search "今日天气" --key <requestKey>
```

- `qq reply` / `qq send` 自动校验本地图片（JPEG/PNG ≤3 MiB）与 MP3 语音（`audio/mpeg` ≤3 MiB）魔数并做 Base64 编码；`qq send` 与 `qq search --conversation` 自动生成标准 UUID `requestKey`。

## 只读作品册查询与归档（`gallery`）

```powershell
cli-anything-huiyu --json gallery list --kind image --character nene --page-size 20
cli-anything-huiyu --json gallery show <作品ID>
cli-anything-huiyu --json gallery save <作品ID> .\archive.png
```

- 严格只读，支持按 `kind`、`character`、`search`、`favorite`、`tag`、`engine`、`model`、`review-state` 筛选；`gallery save` 自动兼容直连 Range 与中转 `?part=N&count=M` 并校验 SHA-256。

## 错误处理与退出码

- 单次命令成功时 JSON 写入标准输出。命令失败时退出码为 1，标准错误含 `code`、`message`、`retryable` 以及适用的 `httpStatus`、`requestKey`、`hint` 和 `retryAfterSeconds`。交互模式的 `@last` 仅在当前会话内有效。
