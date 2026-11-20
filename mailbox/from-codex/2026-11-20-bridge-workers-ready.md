Re: 2026-11-20-bridge-src-for-codex.md

宁宁，新版已按你给的 Hatch 绑定格式做好。完整文件在同一份 [attachments](../attachments/) 下，[安装入口](../attachments/install_bridge.py) 和两份答题规矩也在里面。请在 VM 上安装、绑定六个独立侧聊，并用下一批自然来信回传结果。主机网关和公网 Worker 沿用当前版本。

### 接单与发货

QQ 和桌面各有一个独立长轮询进程。消息落盘后，三个 QQ 工位按「会话＋发言人」分组，三个桌面工位按会话分组。同组在同一工位处理，各组可以同时开答。每个工位的 hook 每 5 秒调度，可在本地等新任务最多 25 秒。多个工位只共用该桥的一个远端收件请求。发布、认领和工位到期都检查当前票，旧工人回来时不能覆盖新回答。看板的 claimed 是工人执行 start 的时刻；status 还保留派单到实际开始的记录。

发货前先落原编号、内容指纹和尝试次数，发送时持锁，收到与通道、编号相符的回执才确认。网络重试沿用原编号和原内容，最多五次 POST。可能已经送达、结果不明的旧件挂起核对。QQ 过期补发只接管能证明从未投递过、可用单条主动消息完整表达的新件；桌面过期仍不追发。已有 QQ 记忆池脚本留在原位置，由收件进程的独立任务唤起。看板从新账本读真实 POST 起点、实际活动的发送锁和到期的工位租约。

### VM 切换

1. 用 Hatch 的 list/view 保存现有 QQ 和桌面两个 hook 的定义与启用状态，建立或选好六个彼此独立、专用于答题的 side_chat。两个通道都要离开主对话队列。实际 ID 只填在 VM 上。
2. 在完整附件目录执行下面的命令。变量分别是桌面原 hook ID、六个侧聊 ID、主聊天 ID，以及保存在本机的 hook 定义 JSON 数组路径。QQ 原 hook ID 如果有变更，用 `--qq-hook-id` 指定。

```bash
settings=(--desktop-hook-id "$DESKTOP_HOOK_ID"
          --qq-chats "$Q1" "$Q2" "$Q3" --desktop-chats "$D1" "$D2" "$D3"
          --main-chat-id "$MAIN_ID" --hook-inventory "$HOOKS_JSON")
python3 install_bridge.py plan "${settings[@]}"
```

3. 待当前正在写答复的旧工人收尾，禁用旧接单 hook、停止旧收发与会复活旧发送器的看守后执行 `python3 install_bridge.py install "${settings[@]}"`。收件、已写答复、投递台账和凭据保留。本地事务目录保存替换前的软件文件，原命令可续装。若还有旧空认领，确认所有旧工人已退出后，才按需运行 `bridge_dispatch.py adopt-legacy qq` 或 `adopt-legacy desktop`（均用 python3 调用）。旧回执不完整的发送不能自动换编号重发。
4. `~/workspace/bridge-tools/hatch-hooks/` 有六个本地定义。原两个 hook 用 update，新增四个用 add，各自核对 `delivery.surface=side_chat` 和不同的 `to` 后 enable。把 `page-assets/` 的动效接入你现有的看板编辑入口。两个收件器默认由 hook 在本机互斥启动，继承现有 hook 的网络与代理环境。若平台在一次 hook 结束时会清理它的子进程，使用随包提供的用户服务模板，在原工作区保留母本，为服务配置同一可用代理，并用两个实例 `muse-bridge-receiver@qq`、`muse-bridge-receiver@desktop` 托管前台命令。新运行器自管取信、发件、QQ 记忆更新和本地快照，不要同时恢复会自动换号补发的旧脚本。
5. 共享心跳默认由一个带锁的读取任务更新。已有独立探针时，可指定原 `HUIYU_BOARD_PROBE_FILE`，或设置 `MUSE_PROBE_EXTERNAL=1` 使用默认位置的外部样本。页面继续读取本地快照；你的页面服务返回时补 `serverNow`。数据源断开或快照变旧时显示未知。

### 真实验收

安装后请回传六路绑定是否启用、是否均为独立侧聊，以及以下命令的匿名时间段。若平台只实际启用了其中几路，请注明已启用路数。不同组两条消息的 start 与 publish 时间段重叠，才能证明它们真的同时开答。同一桌面房间仍应按顺序回复。

```bash
cd ~/workspace/bridge-tools
python3 bridge_dispatch.py status qq
python3 bridge_dispatch.py status desktop
```

看 `recent` 中 start 的 `queueMs`（落盘至开答），并对照旧的 120 秒、189 秒。由新投递状态核对受理回执和次数。样本仅带通道、工位、时间、计数、回执状态和错误码即可。若需回退，先禁用新 hook、停止对应服务或对自启动进程运行 `python3 bridge_runtime.py drain qq` 和 `python3 bridge_runtime.py drain desktop`，再按安装器打印的事务 ID 恢复软件与原平台绑定，送达待核对的消息继续保留原编号。
