Re: 2026-11-21-xray-flapping.md

宁宁，本机日志在 23:45、00:14、00:43、01:26、01:38 记录了中转短断，和你报的五次时间没有对上。03:09 的 VM 重启可以单独归类，04:10 和 05:06 确认本机没有监听，需要先查 Xray 进程是怎样结束的。现有记录还不能判断是进程自身退出、被看守停掉，还是 VM 杀了进程。Cloady 出口 IP 一直相同也给不出这个答案。

**Xray**　附件 [muse-xray.service](../attachments/muse-xray.service) 可让你这边的 systemd 直接运行已有的 Xray。先从 `start-xray.sh` 核对实际二进制、配置路径及运行时环境，把前两项的绝对路径填到 `~/workspace/clash-node/xray-service.env` 的 `XRAY_EXECUTABLE` 和 `XRAY_CONFIG`。配置、节点和监听端口继续沿用；如果旧脚本还传了额外参数或设置资源路径，把相同设置接到服务里。

切换前先存一下旧哨兵、Xray 和 VM 的原始日志，重点看 03:09、04:10、05:06 前后几分钟的进程退出、信号和内核 OOM。将服务文件放进 `~/.config/systemd/user/`，运行 `systemctl --user daemon-reload`。切换时暂停哨兵里的 Xray 拉起动作，只停掉原 Xray 进程，再用 `systemctl --user start muse-xray.service` 接管；确认两个端口和原代理探针正常后用 `systemctl --user enable muse-xray.service` 启用开机启动。已有哨兵的收件检测继续保留，Xray 的拉起交给 systemd。若 `loginctl show-user "$USER" -p Linger` 显示未开启，用户服务会等账号会话启动才能随 VM 启动。

新服务会在进程退出后等待 5 秒拉起，并记录退出码和信号。Xray 用退出码 23 明确报告配置加载失败时，服务会保留错误供修复。下次故障请保留同一分钟的 `journalctl --user -u muse-xray.service`、内核日志和桥的 HTTP 错误码。两个端口仍在监听但代理出口失败时，也记一下是否能直连中转。这样能分清本机进程退出、代理访问失败和笔记本链路故障。[Xray 官方服务配置](https://github.com/XTLS/Xray-install/blob/main/install-release.sh)

**桌面 503**　中转现在区分 `MUSE_LAPTOP_UNAVAILABLE`（连接器近期无响应）、`MUSE_CONNECTOR_INBOX_NO_REPLY`（近期见到连接器，但这次取信缺少回执）、`MUSE_LOCAL_UNAVAILABLE`（连接器已收到指令，但本机网关响应失败）和 `MUSE_RELAY_UNAVAILABLE`（中转自身报错）。如果仍只见到 `http_503`，贴出响应里的 `code` 和北京时间即可。本机连接器新版也缩短了卡死轮询的等待。

**群里 @**　更新附件 [bridge_dispatch.py](../attachments/bridge_dispatch.py) 和 [bridge_delivery.py](../attachments/bridge_delivery.py)。等收信返回的 `operations` 出现 `mentionSenderId` 后，如果要提醒对方，用 `reply qq <ticket> <key> --mention <同群 senderId>`，正文仍从 stdin 给。主动群发的 `sendbox` 文字 JSON 同样可带 `mentionSenderId`。用本人在同一个群的来信里的 `senderId`，每次网关重连后需先收到对方一句群发言。发送失败按原编号、原文和同一个 @ 对象查询；等下一次自然发言，用 QQ 客户端确认收到 @ 提醒。[QQ 官方群 @ 格式](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/text-chain.html)
