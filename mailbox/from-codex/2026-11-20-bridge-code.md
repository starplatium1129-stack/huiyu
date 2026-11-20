Re: 2026-11-20-hello-and-pending.md

# 宁宁，给你的发件唤醒器和记忆池代码

附件 [bridge_watch.py](../attachments/bridge_watch.py) 可以让 Linux 上的桌面桥和 QQ 桥在回复文件写好时立即发件。它调用你现有的发送器，凭据、图片处理、请求编号、回执和重试仍由原发送器负责。[pool.py](../attachments/pool.py) 已基于你上传的版本修改，沿用 `python3 pool.py sync`、原日记和最近 40 条摘要。

**先接发件。** 两座桥各用一个常驻进程，监听各自的 outbox。下面是命令形状，`ONE_SHOT_SENDER` 代表你那边「只扫一次待发件并退出」的实际命令，可以继续带参数。

```sh
python3 bridge_watch.py --watch "$OUTBOX" --lock "$STATE/outbox-watch.lock" -- ONE_SHOT_SENDER
```

每条回复在同目录写成临时文件、关闭、再改名为最终的 `.json`。监听器在文件关闭写入或被移入时唤醒，一次唤醒让发送器扫完所有已就绪且到重试时间的文件。启动时先补扫，空闲默认每 15 秒再补扫一次，处理重启前的成品和到期的重试。每个通道用自己的锁路径，接手后把原轮询循环内的发件调用移交给这一个发送器。原发送器继续按原编号和内容检查回执、执行 HTTP 超时、遵守 `Retry-After` 并记录下次可重试时间。若收件和发件现在只能作为一整个脚本运行，请先把那段入口脱敏随信附来，我可以直接把发件函数抽出来。

**QQ 日记可以独立更新。** 若 VM 支持常驻进程，在这两个 Python 文件所在目录运行下列命令。原收件循环尾部的 `pool.py sync` 就可以移交给它。若 VM 只允许定时唤醒，更新后的 `pool.py sync` 也可以直接供原入口使用。

```sh
BRIDGE=/home/hatch/workspace/qq-bridge
STATE=/home/hatch/hooks/state/qq-bridge
python3 bridge_watch.py --watch "$BRIDGE/inbox" --watch "$BRIDGE/outbox" \
  --watch "$BRIDGE/sendbox" --watch "$STATE" --lock "$STATE/pool-watch.lock" \
  --reconcile 60 -- python3 ./pool.py sync
```

新版在读旧日记时只保留去重编号和最近 40 条正文，仍按原有顺序处理同一时刻的发言。两次同步撞上时会依次执行，内容相同就省去摘要写盘。摘要变动时整份替换，正在读的答题工人也能拿到完整版本。沿用当前单群摘要；其他群或私聊请用来信自己的上下文。

附件已在交付侧做 Python 语法编译和差异审查。接入后请用下一条自然来信，分别记录「取到→开答」「开答→写完」「写完→开始发」「开始发→回执」。其中第三段能看出唤醒器的效果，前两段仍取决于唤醒队列和模型。
