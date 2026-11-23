---
name: cli-anything-huiyu
description: 为 Muse 和其他智能体操作同一台绘遇桌面出图机。支持本机、Tailscale 和 HTTPS 中转，可搜索素材、交接绘图任务、定位生成和交付错误并保存原图。
---

# 操作绘遇桌面绘图

Windows 安装包的入口是安装目录下的 `gateway\tools\cli-anything-huiyu\cli-anything-huiyu.exe`。将该目录加入当前终端的 PATH 后，可以直接使用下列命令。源码入口是 `node tools/cli-anything-huiyu/cli.mjs`，需要从任意目录调用时也可以在仓库根目录运行 `npm install --global ./tools/cli-anything-huiyu`。

在另一台助手主机上，将命令行包复制过去，用 Node.js 22.18 或以上版本运行 `npm install --global ./cli-anything-huiyu-1.2.0.tgz`。安装后运行 `cli-anything-huiyu --json help`，即可读取本机可用命令和本说明文件的位置。

## 接到聊天模型

项目聊天、桌宠和 QQ 使用支持工具调用的模型时，绘遇会注册 `huiyu_drawing`。项目聊天与桌宠需开启房间工具，QQ 需开启对应会话的本机绘图。外部 Muse 或其他模型客户端可以从 `cli-anything-huiyu --json help invoke` 返回的 `commands.invoke.tool` 注册相同的函数。调用时把模型的参数对象编码成 UTF-8 JSON，送入 `cli-anything-huiyu --json invoke` 的标准输入，读取本次进程的成功或错误回执。

```powershell
'{"action":"status"}' | cli-anything-huiyu --json invoke
```

要交给另一位助手接手，先用 `{"action":"key"}` 获取编号，提交时传 `{"action":"draw","batchKey":"取得的编号","params":{"id":"目录 ID"}}`。把返回的 `batchKey` 发给对方，对方即可用 `{"action":"errors","batchKey":"同一个编号"}` 排错。普通对话出图卡沿用原会话的恢复和取图方式。内置群机器人只可凭编号查或取消本群当前发起人的共享任务，全机历史和归档在机主私聊使用。内置工具的 `save` 将 PNG 存入桌面运行目录的 `agent-drawings`；外部工具进程可用 `HUIYU_CLI_OUTPUT_DIR` 指定归档目录，默认使用当前目录。

各助手连接同一台出图机即可共享队列和回执。桌面端需开启「允许其他绘遇连接本机绘图」并在首次保存后重启。根据运行位置为助手进程配置连接。对接 QQ 收件箱的外部 Muse 应按每封来信的 `drawingAllowed` 决定是否提供工具，并把 `sharedDrawing.scope` 作为该次 `invoke` 子进程的 `HUIYU_CLI_SCOPE`。聊天中的大回执会标记 `truncated`，可缩小分页或用对应的只读子命令查看全量。

| 助手位置 | 地址 | 凭据环境变量 |
| --- | --- | --- |
| 出图机本机 | 默认 `http://127.0.0.1:3211`，自定义端口用 `HUIYU_CLI_PORT` | `HUIYU_CLI_TOKEN`，来自原生绘图设置 |
| Tailscale 对端 | `HUIYU_CLI_URL=http://<出图机的 Tailscale IPv4>:<转发端口>` | `HUIYU_CLI_TOKEN` |
| Muse HTTPS 中转 | `HUIYU_CLI_URL=https://<已配置的中转域名>` | `MUSE_TOKEN`，使用中转的 X-Token |

在每个助手自己的进程环境设置可选的 `HUIYU_CLI_AGENT`，例如 `muse` 或 `codex`。新生成的编号带有该前缀，显式传入的编号会原样保留。共用连接凭据的助手具有相同的队列访问权限。

```powershell
cli-anything-huiyu --json status
cli-anything-huiyu --json catalog --kind scene --character nene --page-size 5
cli-anything-huiyu --json detail scene <目录ID>
cli-anything-huiyu --json key
cli-anything-huiyu --json draw --id <目录ID> --key <上一步的requestKey>
cli-anything-huiyu --json job <batchKey>
cli-anything-huiyu --json save <batchKey> "成图.png" --item 1
```

- 搜索结果用 `items[].id` 取完整 ID，有 `nextPage` 时传给 `--page`。
- 自定义绘图用 `draw --prompt "提示词"`，多行提示词及模型参数用 `draw --file 单图.json`。批量绘图用 `batch 批量.json`，例如文件内容为 `{"items":[{"id":"sc041"},{"id":"sc093"}]}`。
- 交接时传递出图机标识和回执里的 `batchKey`。后续助手用同一编号查询；需要重发时沿用原编号和完整参数，避免重复出图。
- `queue` 查看排队情况，`recent` 找回近期回执。轮询同一批次时隔至少两秒。遇到失败或取消时读取该项的 `error`，到达本次等待时限后保留批次编号。
- 指定项的 `resultAvailable` 为 `true` 后使用 `save`。目标目录需已存在且支持硬链接（Windows 通常为 NTFS）。成功返回绝对路径、字节数和 SHA-256。
- 用户要取消时用 `cancel <batchKey>`，或加 `--item 2` 只取消第二张。取消回执中的 `cancelErrors` 表示个别项目需要用 `job` 复查。
- 用 `errors <batchKey>` 定位哪一张、哪个模型遇到生成或交付问题。尚无编号时用 `errors --agent muse --limit 50` 查一页历史。空页仍可能有 `nextBefore`，用 `--before` 继续。既有无前缀任务可用不带 `--agent` 的查询找回。主动取消可通过 `job` 查看。
- 单次命令成功时 JSON 写入标准输出。命令失败时退出码为 1，标准错误含 `code`、`message`、`retryable` 以及适用的 `httpStatus`、`requestKey`、`hint` 和 `retryAfterSeconds`。请求被拒或未送达时，请保留这条错误回执供交接。交互模式的 `@last` 仅在当前会话内有效。
- 只有 HTTP 工具的助手可带 X-Token 读取 `GET /api/muse/guide`，再用 `GET /api/muse/batches/{batchKey}` 查看相同的回执。错误位于 `items[].code`、`error` 和中转的 `deliveryStatus`。用 `GET /api/muse/jobs` 查看历史。
