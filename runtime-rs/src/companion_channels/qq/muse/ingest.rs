use super::*;

const GROUP_MEMBER_LIMIT: usize = 512;

impl Message {
    fn muse_filtered(&self, reason: &str) {
        eprintln!(
            "QQ Muse stage=filtered msg={} reason={reason}",
            message_tag(&self.id)
        );
    }
}

impl Mailbox {
    fn remember_group_member(&self, entry: &Entry) {
        let mut members = self.group_members.lock().unwrap();
        if let Some(index) = members.iter().position(|member| {
            member.conversation_id == entry.conversation_id && member.sender_id == entry.sender_id
        }) {
            members.remove(index);
        }
        if members.len() >= GROUP_MEMBER_LIMIT {
            members.pop_front();
        }
        members.push_back(GroupMember {
            conversation_id: entry.conversation_id.clone(),
            sender_id: entry.sender_id.clone(),
            openid: entry.sender_openid.clone(),
        });
    }

    async fn enqueue(
        self: &Arc<Self>,
        app: &AppState,
        message: &Message,
        question: &str,
        settings: &Settings,
        tasks: &mut tokio::task::JoinSet<()>,
    ) -> Option<&'static str> {
        match &self.route {
            Route::Invalid => {
                message.muse_filtered("invalid_route");
                return Some(
                    "Muse 虚拟机配置无效，请机主检查 muse-qq-vm.json 后重新保存 QQ 连接。",
                );
            }
            Route::Pull if !crate::images::remote::listening() => {
                message.muse_filtered("listener_disabled");
                return Some("Muse 接口尚未启动。请机主在绘遇的原生绘图设置里开启「允许连接」。");
            }
            _ => {}
        }
        if self.entries().iter().any(|entry| {
            entry.message_id == message.id
                && entry.scope == message.scope
                && entry.target == message.target
        }) {
            message.muse_filtered("duplicate");
            return None;
        }
        let expires_at = message.received_at + message.scope.reply_window_ms();
        if expires_at <= crate::host::now_ms() {
            message.muse_filtered("expired");
            return None;
        }
        let conversation_id = self.api.conversation_id(message.scope, &message.target);
        let sender_id = muse_sender_id(&conversation_id, &message.member);
        let nickname = message.nickname.clone().or_else(|| {
            let names = match &self.route {
                Route::Vm(endpoint) => &endpoint.callback.names,
                Route::VmPoll(endpoint) => &endpoint.names,
                _ => return None,
            };
            let name = names.get(&message.target)?.get(&message.member)?.trim();
            (!name.is_empty()).then(|| name.chars().take(128).collect())
        });
        let query = lookup::explicit_query(question).map(str::to_owned);
        let mut entry = Entry {
            key: uuid::Uuid::new_v4().to_string(),
            target: message.target.clone(),
            scope: message.scope,
            ambient: message.ambient,
            sender_openid: message.member.clone(),
            nickname,
            sender_role: message.group_role.unwrap_or("unknown"),
            timestamp: message.sent_at.unwrap_or(message.received_at),
            message_id: message.id.clone(),
            conversation_id,
            sender_id,
            question: question.to_owned(),
            recent_messages: Vec::new(),
            images: message.images.clone(),
            drawing_allowed: !message.ambient && match message.scope {
                QqScope::Group => settings.group_drawing,
                QqScope::Private => settings.drawing,
            },
            search: query.as_ref().map(|_| OnceLock::new()),
            attach_nene: matches!(self.route, Route::VmPoll(_))
                && attachment::requests_nene_photo(question, &settings.character),
            expires_at,
            arrived_at: message.arrived_at,
            listed: AtomicBool::new(false),
            send_attempted: AtomicBool::new(false),
            delivery: AsyncMutex::default(),
        };
        if entry.scope == QqScope::Group {
            self.remember_group_member(&entry);
        }
        entry.recent_messages = self
            .history
            .receive(&entry, settings.muse_context_limit)
            .await;
        let mut entries = self.entries();
        let now = crate::host::now_ms();
        if self.cancel.is_cancelled() || entry.expires_at <= now {
            message.muse_filtered("closed_or_expired");
            return None;
        }
        if entries.len() >= INBOX_LIMIT * 8 {
            entries.retain(|entry| entry.expires_at > now);
        }
        if entries.len() >= INBOX_LIMIT
            && (entries.len() >= INBOX_LIMIT * 8
                || entries
                    .iter()
                    .filter(|e| e.expires_at > now)
                    .filter(|e| e.delivery.try_lock().map_or(true, |d| !e.done(&d)))
                    .count()
                    >= INBOX_LIMIT)
        {
            message.muse_filtered("inbox_full");
            return Some("Muse 正在处理较多消息，请稍后再发。");
        }
        let entry = Arc::new(entry);
        entries.push_back(entry.clone());
        drop(entries);
        eprintln!(
            "QQ Muse stage=enqueued msg={} requestKey={} recentMessages={} searchPending={}",
            message_tag(&message.id),
            entry.key,
            entry.recent_messages.len(),
            query.is_some()
        );
        if query.is_none() {
            self.inbox_changed.send_replace(());
        }
        if query.is_some() || matches!(&self.route, Route::Vm(_)) {
            let mailbox = self.clone();
            let app = app.clone();
            tasks.spawn(async move {
                if let (Some(query), Some(search)) = (query, &entry.search) {
                    let result = lookup::run(&app, &mailbox, Some(&entry), &query)
                        .await
                        .unwrap_or_else(|e| json!({"ok":false,"error":e.message}));
                    let _ = search.set(result);
                    entry.trace("search_ready");
                    mailbox.inbox_changed.send_replace(());
                }
                if let Route::Vm(endpoint) = &mailbox.route {
                    endpoint.forward(&app, &mailbox, &entry).await;
                }
            });
        }
        None
    }
}

// Read the binding at intake so unbinding takes effect even while the group chat
// worker is waiting for a model or delivering a batch of images.
pub(in crate::companion_channels::qq) async fn process(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    api: &Api,
    mut inbox: mpsc::Receiver<Message>,
) {
    let mut forwarding = tokio::task::JoinSet::new();
    let mut members = members::Directory::default();
    loop {
        let mut message = tokio::select! {
            Some(_) = forwarding.join_next(), if !forwarding.is_empty() => continue,
            next = inbox.recv() => match next { Some(message) => message, None => break },
        };
        let notice = {
            let lock = app.channels.write.lock().await;
            let Ok(Some(settings)) = read_bot_by_app_id(app, storage, principal, &api.app_id).await
            else {
                message.muse_filtered("settings_unavailable");
                continue;
            };
            if !is_current(app, storage) || !settings.enabled {
                message.muse_filtered("connection_changed");
                continue;
            }
            if !allows(&settings, message.destination()) {
                message.muse_filtered("unbound");
                continue;
            }
            if message.ambient && !settings.group_muse_all {
                message.muse_filtered("ambient_disabled");
                continue;
            }
            if !settings.muse_for(message.scope, &message.target) {
                message.muse_filtered("muse_disabled");
                Some("这个对话还没有启用 Muse。可以请机主在绘遇的 QQ 连接设置里开启。")
            } else if message.text.is_empty() {
                message.muse_filtered("missing_question");
                Some("请 @ 我并写上问题，例如「今天画什么好？」。")
            } else if message.text.chars().nth(1600).is_some() {
                message.muse_filtered("text_too_long");
                Some("Muse 每条提问最多 1600 字，请分开发送。")
            } else {
                match Mailbox::current(app) {
                    Ok(mailbox) => {
                        drop(lock);
                        members.enrich(api, &mut message).await;
                        if mailbox.cancel.is_cancelled() {
                            message.muse_filtered("connection_changed");
                            continue;
                        }
                        mailbox
                            .enqueue(app, &message, &message.text, &settings, &mut forwarding)
                            .await
                    }
                    Err(_) => {
                        message.muse_filtered("mailbox_unavailable");
                        Some("Muse 群聊连接正在更新，请稍后再发。")
                    }
                }
            }
        };
        if let Some(notice) = notice
            && !message.ambient
        {
            let _ = api.text(message.destination(), &message.id, notice).await;
        }
    }
}
