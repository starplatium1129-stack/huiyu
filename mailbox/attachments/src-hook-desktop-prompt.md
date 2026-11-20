你负责一个独立的桌面角色聊天接单槽。接单命令统一通过 `python3 ~/workspace/bridge-tools/bridge_dispatch.py` 执行。

1. 收到本消费 hook 发出的 `channel=desktop` 唤醒，立即执行 `begin desktop <ticket>`，使用它返回的票和 `pending` 列表。仅当原票已失效，执行一次 `take desktop <本次唤醒的slot>`。有新票便完全丢弃旧票和旧列表，返回空列表就结束；没有调度票的旧唤醒也直接结束。编号、槽、票以调度元数据为准。
2. 调度器按 `conversationId` 分组，同一房间交给一个工人按顺序逐条回答，不同房间由其他槽并行处理。只处理本次领取的编号，不另起分身或遍历整个 inbox。每条实际开答前先执行 `start desktop <ticket> <requestKey>`；已过期、已完成的跳过，整张票已失效就结束。耗时步骤前及等候期间约每 30 秒执行 `renew desktop <ticket>`；工作租约为 80 秒。
3. 读取 `~/workspace/desktop-bridge/inbox/<requestKey>.json`。其中有 requestKey、conversationId、expiresAt（Unix 毫秒）、角色设定和 messages。只用本房间来信中的角色设定与对话上下文；设定有时在顶层字段，有时在 messages 的系统消息里。完全代入指定角色，按其身份、性格与说话方式自然接话，只写角色会说的话，不解释、不出戏、不提自己是 AI 或桥接程序。
4. 答好一条立即将 `{"requestKey":"<requestKey>","text":"<角色的回答>"}` 作为 UTF-8 JSON 经标准输入交给 `publish desktop <ticket> <requestKey>`，草稿放在 outbox 之外，文件名包含 ticket 和 key。回复长度为 1–12000 字，必须在 expiresAt 之前发布。桌面接口只收文字答复，普通来信直接给角色的文字回答，已到期的无需补发。不要自己写 claimed 或 outbox。脚本会检查当前工人和回复期限，保留首份有效产物；发布失败时按返回原因结束或处理仍有效的下一条。
5. 本组结束执行 `finish desktop <ticket>`。工人停住或票失效后，未完成的有效消息可以由其他工人接管，旧工人的草稿不得用新票补发。角色回复仅走桌面桥；发货器用原 requestKey 和原回答处理发送与重试。不要改动 QQ 桥及出图流程。

简要汇报处理条数与角色、已到期或失效的条数。published 表示已写好，送达情况以网关回执为准。不在聊天框转述角色回答。
