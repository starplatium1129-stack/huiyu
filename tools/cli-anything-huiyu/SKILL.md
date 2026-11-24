---
name: cli-anything-huiyu
description: 为 Muse 和其他智能体操作同一台绘遇桌面出图机。支持本机、Tailscale 和 HTTPS 中转，可搜索素材、交接绘图任务、定位生成和交付错误并保存原图。
---

# 操作绘遇桌面绘图

Windows 安装包的入口是安装目录下的 `gateway\tools\cli-anything-huiyu\cli-anything-huiyu.exe`。将该目录加入当前终端的 PATH 后，可以直接使用下列命令。源码入口是 `node tools/cli-anything-huiyu/cli.mjs`，需要从任意目录调用时也可以在仓库根目录运行 `npm install --global ./tools/cli-anything-huiyu`。

在另一台助手主机上，将命令行包复制过去，用 Node.js 22.18 或以上版本运行 `npm install --global ./cli-anything-huiyu-1.4.0.tgz`。安装后运行 `cli-anything-huiyu --json help`，即可读取本机可用命令和本说明文件的位置。

## 接到聊天模型

项目聊天、桌宠和 QQ 使用支持工具调用的模型时，绘遇会注册 `huiyu_drawing`。项目聊天与桌宠需开启房间工具，QQ 需开启对应会话的本机绘图。外部 Muse 或其他模型客户端可以从 `cli-anything-huiyu --json help invoke` 返回的 `commands.invoke.tool` 注册相同的函数。调用时把模型的参数对象编码成 UTF-8 JSON，送入 `cli-anything-huiyu --json invoke` 的标准输入，读取本次进程的成功或错误回执。

```powershell
'{"action":"status"}' | cli-anything-huiyu --json invoke
```

要交给另一位助手接手，先用 `{"action":"key"}` 获取编号，提交时传 `{"action":"draw","batchKey":"取得的编号","params":{"id":"目录 ID"}}`。把返回的 `batchKey` 发给对方，对方即可用 `{"action":"errors","batchKey":"同一个编号"}` 排错。普通对话出图卡沿用原会话的恢复和取图方式。内置群机器人只可凭编号查或取消本群当前发起人的共享任务，全机历史和归档在机主私聊使用。内置工具的 `save` 将 PNG 存入桌面运行目录的 `agent-drawings`；外部工具进程可用 `HUIYU_CLI_OUTPUT_DIR` 指定归档目录，默认使用当前目录。

聊天模型可用 `{"action":"models","params":{"character":"nene"}}` 查询角色 LoRA。工具提交后会立即返回批次编号。命令行使用者可通过 `wait` 续查，或在提交时指定本机输出路径。

各助手连接同一台出图机即可共享队列和回执。桌面端需开启「允许其他绘遇连接本机绘图」并在首次保存后重启。根据运行位置为助手进程配置连接。对接 QQ 收件箱的外部 Muse 应按每封来信的 `drawingAllowed` 决定是否提供工具，并把 `sharedDrawing.scope` 作为该次 `invoke` 子进程的 `HUIYU_CLI_SCOPE`。聊天中的大回执会标记 `truncated`，可缩小分页或用对应的只读子命令查看全量。

| 助手位置 | 地址 | 凭据环境变量 |
| --- | --- | --- |
| 出图机本机 | 默认 `http://127.0.0.1:3211`，自定义端口用 `HUIYU_CLI_PORT` | `HUIYU_CLI_TOKEN`，来自原生绘图设置 |
| Tailscale 对端 | `HUIYU_CLI_URL=http://<出图机的 Tailscale IPv4>:<转发端口>` | `HUIYU_CLI_TOKEN` |
| Muse HTTPS 中转 | `HUIYU_CLI_URL=https://<已配置的中转域名>` | `MUSE_TOKEN`，使用中转的 X-Token |

在每个助手自己的进程环境设置可选的 `HUIYU_CLI_AGENT`，例如 `muse` 或 `codex`。新生成的编号带有该前缀，显式传入的编号会原样保留。共用连接凭据的助手具有相同的队列访问权限。

```powershell
cli-anything-huiyu --json status
cli-anything-huiyu --json doctor
cli-anything-huiyu --json models --model anima-miaomiao-v1.6 --character nene
cli-anything-huiyu --json catalog --kind scene --character nene --page-size 5
cli-anything-huiyu --json detail scene <目录ID>
cli-anything-huiyu --json key
cli-anything-huiyu --json draw --id <目录ID> --key <上一步的requestKey>
cli-anything-huiyu --json wait <batchKey>
cli-anything-huiyu --json save <batchKey> "成图.png" --item 1
```

- 搜索结果用 `items[].id` 取完整 ID，有 `nextPage` 时传给 `--page`。
- 自定义绘图用 `draw --prompt "提示词"`，或用 `draw --prompt -` 从标准输入读取 UTF-8 文本。`draw --file -` 和 `batch -` 接收 UTF-8 JSON，体积上限分别为 64 KiB 和 256 KiB。批量也可用 `batch --ids sc041,sc093`，或重复传 `--ids`。
- 交接时传递出图机标识和回执里的 `batchKey`。后续助手用同一编号查询；需要重发时沿用原编号和完整参数，避免重复出图。
- `queue` 查看排队情况，`recent --agent muse --status failed` 按助手名和任务状态查历史。空页仍可能有 `nextBefore`，用 `--before` 继续。加 `--compact` 可精简 JSON 回执，完整元数据可用原命令查询。
- `wait` 支持 `--item`、`--timeout` 和 `--interval`，默认等 300 秒，查询间隔至少两秒。超时回执带 `timedOut: true` 和 `batchKey`，可用同一编号继续等待。遇到失败或取消时读取该项的 `error`。
- `save --all` 以 `huiyu-<batchKey>-<序号>.png` 命名，返回 `saved`、`pending` 和 `failed`。目标父目录自动创建，保存回执含绝对路径、字节数和 SHA-256。原图至少 1 MiB 时默认四路下载，必要时续传校验过的分片。用 `--single-connection` 改为单连接。Windows 支持硬链接或系统原子移动，其他平台的目标目录需要支持硬链接。
- 用户要取消时用 `cancel <batchKey>`，或加 `--item 2` 只取消第二张。取消回执中的 `cancelErrors` 表示个别项目需要用 `job` 复查。
- 用 `errors <batchKey>` 定位哪一张、哪个模型遇到生成或交付问题。尚无编号时用 `errors --agent muse --limit 50` 查一页历史。空页仍可能有 `nextBefore`，用 `--before` 继续。既有无前缀任务可用不带 `--agent` 的查询找回。主动取消可通过 `job` 查看。
- 单次命令成功时 JSON 写入标准输出。命令失败时退出码为 1，标准错误含 `code`、`message`、`retryable` 以及适用的 `httpStatus`、`requestKey`、`hint` 和 `retryAfterSeconds`。请求被拒或未送达时，请保留这条错误回执供交接。交互模式的 `@last` 仅在当前会话内有效。
- 只有 HTTP 工具的助手可带 X-Token 读取 `GET /api/muse/guide`，再用 `GET /api/muse/batches/{batchKey}` 查看相同的回执。错误位于 `items[].code`、`error` 和中转的 `deliveryStatus`。用 `GET /api/muse/jobs` 查看历史。

## 设置本次出图的模型与加速

```powershell
cli-anything-huiyu --json draw --id sc093 --tea-cache-thresh 0.06
cli-anything-huiyu --json draw --id sc093 --tea-cache off --seed 42
cli-anything-huiyu --json batch 批量.json --tea-cache-thresh 0.08
```

目录出图可用 `--kind` 指定记录类型，配合 `--outfit` 给同角色换装，也可只传 `--outfit` 出服装图。自定义提示词可用 `--negative`、`--steps`、`--cfg`、`--character`、`--lora`、`--lora-strength`、`--style-lora`，具体支持随模型变化。

Anima 的 TeaCache 默认开启，阈值通常为 `0.10`。可传 `0` 到 `1` 的小数，`0` 或 `--tea-cache off` 都会停用加速。省略这些参数时沿用模型或目录配方默认。使用 `--width` 和 `--height` 时一起指定。用 `help draw` 或 `help batch` 查看模型、种子、变体、放大和 MOSS 加速的选项。

`--file`、`batch` 文件、工具的 `params` 和 Muse HTTP 请求都使用 `teaCache`（布尔值）和 `teaCacheThresh`（数字）。命令行参数覆盖文件顶层的同名值。批量时各项可以覆盖整批默认值，例如 `{"teaCacheThresh":0.08,"items":[{"id":"sc041"},{"id":"sc093","teaCache":false}]}`。混合模型的批次只在 Anima 项内填写 TeaCache 参数。

`guide` 读取出图机的 Muse 接口说明。`models` 查询已装模型、尺寸默认值、LoRA、放大权重和加速方式。老版本出图机回退到接口说明与可访问的模型状态，其中 `available: null` 表示尚未确认。`doctor` 检查连接、凭据格式和协议能力，只报告环境变量的设置状态。TeaCache 参数需要出图机已支持它，可用 `doctor` 确认。

## 提交、等待并保存

```powershell
cli-anything-huiyu --json draw --id sc093 --tea-cache-thresh 0.06 --out .\成图.png
cli-anything-huiyu --json batch --ids sc041,sc093 --out-dir .\成图 --timeout 600
cli-anything-huiyu --json wait <batchKey> --item 2 --timeout 300
cli-anything-huiyu --json save <batchKey> .\成图 --all
```

`draw --wait` 和 `batch --wait` 只等待回执。传 `--out` 或 `--out-dir` 时也会保存已就绪的图片，即使等待超时，剩余图片仍可凭原批次编号取回。`draw --out` 用于单张图片，多张用 `batch --out-dir`。
