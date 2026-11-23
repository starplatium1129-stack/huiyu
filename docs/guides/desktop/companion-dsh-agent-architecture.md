# 桌面陪伴：工具、陪看与手机聊天

桌宠支持角色聊天、Live2D 动作、语音、看屏/陪看、对话出图与手机聊天接入。看屏与绘图需分别配置兼容的视觉模型或本地绘图模型；待验设备范围见 [未来规划](../../roadmap.md)。

---

## 1. 桌宠可用工具与权限

| 工具 | 对应实现 | 能力与权限边界 |
| --- | --- | --- |
| `capture_screen` / `read_image` | `/api/desktop-tools` | 抓取 Windows 主屏或读取 AI 工作区图片 |
| `read_file` / `write_file` | `/api/desktop-tools` | 读写 AI 工作区内文本与配置（解析真实路径，拒绝越界目录联接） |
| `run_command` | `/api/desktop-tools` | 默认关闭；仅 `AICS_DESKTOP_COMMANDS=trusted` 且授权后按当前系统账户执行（非沙箱），撤权见 [STARTUP](../../../STARTUP.md#运行配置与凭据恢复) |
| `generate_character_image` | `/api/tasks/v1` | 复用当前模型与受控角色 LoRA 绑定提交私人任务，入册并保存持久媒体引用 |
| `search_drawing_catalog` / `generate_drawing_batch` | `/api/tasks/v1/companion-draw` | 查询目录或沿用 Muse 配方批量出图（每批 ≤ 16 张） |
| `huiyu_drawing` | 桌面内置 `cli-anything-huiyu` | 项目聊天、桌宠和 QQ 共用绘图任务编号，可交接任务、查队列和报错；需开启本机绘图连接与对应会话的工具权限。[操作示例](../../../tools/cli-anything-huiyu/SKILL.md) |
| `generate_image_from_reference` | `/api/interrogate/raw` → `/api/tasks/v1` | 本机 PixAI 反推参考图后，按当前角色重新编译出图 |

---

## 2. 聊天、视觉、看屏与陪看

- **对话与视觉配置**：在桌宠「设置」填入兼容 API 地址、模型与密钥（本地代理示例 `http://127.0.0.1:8317/v1`，预设定义于 `src/config/chatApi.ts`）。看屏需视觉输入能力，工具调用需流式 Function Calling。
- **看屏幕**：点击输入框右侧 **看屏幕**，优先通过本机 Windows GDI 截取主屏（失败回退浏览器共享屏幕），发送给视觉模型回应。
- **陪看（共享画面点评）**：
  - 桌宠右键菜单或网页舞台右上角进入「陪看」，选择共享窗口/屏幕；本机检测画面明显变化后才发送压缩图。
  - 聊天/语音输入或勿扰期间自动让出或暂停；可选「等共享声音停下再开口」（仅本机检测音量空档，不上传音频）。短评可实时朗读，不写入聊天记录。
  - 隐藏桌宠、切换角色、更换视觉连接或点「结束共享」即释放源。
- **好感度与动作**：互动按动作 `bonus` 加分（部分摸头/摸手 `+5`）；满分 100 解锁原作者专属告白动作（萌萌Q、喝茶邀请、我爱你）。

---

## 3. 对话绘图与反推

- **直接指令出图**：对桌宠发送「用女仆装画三张」或直接要求出图，支持选配场景/蓝图、尺寸与种子（每批最多 16 张）。关闭窗口不停止后台出图，重回原对话可恢复或取消。
- **出图方案确认**：发送「先给我看三张的出图方案」会先生成可逐张微调提示词的出图卡，确认「开始绘图」后再排队；结束后支持单张重试或重绘。
- **图片反推重绘**：独立聊天窗支持选择、粘贴或拖入 PNG/JPEG/WebP。点击 **反推并生成** 直接走本机 PixAI + 绘图模型按当前角色重新生成，不依赖视觉聊天模型。

---

## 4. 手机聊天连接（QQ / 微信）

在「设置 → 手机聊天连接」或控制面板「服务与连接」开启，需保持主机与绘遇运行。手机会话按平台、账号与角色独立保存，支持 `/帮助`、`/开始绘图`、`/取图`（多页用 `/取图 2`）、`/取消`。

- **QQ 私聊**：在 [QQ 开放平台](https://q.qq.com/qqbot/) 创建长连接机器人并填入 `AppID`/`AppSecret`；生成口令后在机器人私聊发送 `/绑定 <口令>`。超过原消息回复期限或未自动回传时发 `/取图`。
- **QQ 群聊**：开通群聊权限并将机器人拉入群；生成口令后在群内 `@机器人 /绑定群 <口令>`。群成员 `@` 机器人即可对话，按需勾选「允许本机绘图 → 已绑定的群聊」。QQ 群消息回复期限为 **5 分钟**，超时发 `@机器人 /取图`。
- **在 QQ 中使用 Muse**：在「服务与连接 → 手机聊天 · QQ」勾选交给 Muse 的会话。具体轮询、附件与 VM 配置见 [远程连接与 Muse 指南](../remote-and-muse.md#3-qq-群与私聊收发muse-协作)。
- **个人微信（OpenClaw）**：同机运行 OpenClaw 并绑定 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)，在项目根目录安装仓库内置桥接插件：
  ```powershell
  openclaw plugins install ./tools/huiyu-wechat-bridge
  ```
  将绘遇「复制桥接配置」写入 `plugins.entries.huiyu-wechat-bridge.config`（替换 `accountId` 并在 `plugins.allow` 中启用），然后在 ClawBot 私聊发送绑定口令。
- **普通微信群卡片**：供群友在微信群通过小程序卡片向 Muse 提问发图，详见 [Muse 微信群卡片](../../../tools/muse-wechat-card/README.md)。
