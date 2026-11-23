use super::replies::{notify, reply};
use super::*;

const MESSAGE_BURST: Duration = Duration::from_millis(1400);
const MAX_BURST_MESSAGES: usize = 4;

#[allow(clippy::too_many_arguments)]
pub(super) async fn process(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    mut settings: Settings,
    voice_profile: &str,
    api: &Api,
    cancel: &CancellationToken,
    scope: QqScope,
    bindings: &RwLock<Bindings>,
    muse: &mpsc::Sender<Message>,
    mut inbox: mpsc::Receiver<Message>,
) {
    let (voice, voice_auto) = settings.voice_for(scope);
    let ctx = Context {
        app,
        storage,
        principal,
        character: &settings.character,
        chat_provider: settings.chat_provider_for(scope),
        is_owner: scope == QqScope::Private,
        owner_bond: settings.owner_bond_kind(),
        owner_call_name: &settings.owner_call_name,
        owner_note: &settings.owner_note,
        drawing: if scope == QqScope::Group {
            settings.group_drawing
        } else {
            settings.drawing
        },
        voice,
        voice_auto,
        voice_profile,
        group_member: None,
        cancel,
    };
    let mut conversations = HashMap::<String, Conversation>::new();
    if scope == QqScope::Group {
        for group in &settings.groups {
            let target = Destination { scope, id: &group.id };
            if let Ok(active) = conversation(&mut conversations, &ctx, &settings.app_id, target).await {
                let recent: Vec<_> = active.recent_replies().collect();
                for text in recent.into_iter().rev() {
                    api.quotes.restore_text(target.id, text);
                }
            }
        }
    }
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pending = None;
    while is_current(app, storage) && !cancel.is_cancelled() {
        tokio::select! {
            _ = cancel.cancelled() => return,
            message = async {
                match pending.take() {
                    Some(message) => Some(message),
                    None => inbox.recv().await,
                }
            } => {
                let Some(message) = message else { return };
                let target = message.destination();
                if !message.to_muse && let Some((requested_scope, code)) = message.pairing_request() {
                    if requested_scope == scope
                        && let Ok(Some(binding)) = pair(app, storage, principal, &settings.id, &settings.app_id, scope, target.id, &message.member, code).await
                    {
                        let reply = {
                            let mut bindings = bindings.write().unwrap();
                            match scope {
                                QqScope::Private => {
                                    settings.owner = binding.owner;
                                    bindings.owner.clone_from(&settings.owner);
                                    conversations.clear();
                                    "已绑定绘遇。现在可以直接发消息，或发送 /帮助 查看用法。"
                                }
                                QqScope::Group => {
                                    settings.groups = binding.groups;
                                    bindings.groups.clone_from(&settings.groups);
                                    "本群已绑定绘遇，已记住你的主人身份。@ 我就能聊天，也可以 @ 我发 /帮助。"
                                }
                            }
                        };
                        let _ = api.text(target, &message.id, reply).await;
                    }
                    continue;
                }
                if !allows(&settings, target) { continue; }
                if message.to_muse {
                    if muse.send(message).await.is_err() { return; }
                    continue;
                }
                let group = collect_burst(message, &mut inbox, &mut pending, cancel).await;
                let message = &group[0];
                let target = message.destination();
                let is_owner = match scope {
                    QqScope::Private => true,
                    QqScope::Group => settings
                        .groups
                        .iter()
                        .find(|group| group.id == target.id)
                        .is_some_and(|group| group.owner_member_id.as_deref() == Some(message.member.as_str())),
                };
                let turn = Context {
                    is_owner,
                    group_member: (scope == QqScope::Group).then_some(message.member.as_str()),
                    ..ctx
                };
                let Ok(active) = conversation(&mut conversations, &turn, &settings.app_id, target).await else { continue };
                reply(&turn, api, active, &group).await;
            }
            _ = tick.tick() => {
                let ids = match scope {
                    QqScope::Private => settings.owner.iter().map(String::as_str).collect::<Vec<_>>(),
                    QqScope::Group => settings.groups.iter().map(|group| group.id.as_str()).collect(),
                };
                for id in ids {
                    let target = Destination { scope, id };
                    if let Ok(active) = conversation(&mut conversations, &ctx, &settings.app_id, target).await {
                        notify(&ctx, api, active, target, &settings).await;
                    }
                }
            }
        }
    }
}

async fn collect_burst(
    first: Message,
    inbox: &mut mpsc::Receiver<Message>,
    pending: &mut Option<Message>,
    cancel: &CancellationToken,
) -> Vec<Message> {
    let mut messages = vec![first];
    let first = &messages[0];
    if first.text.starts_with('/') {
        return messages;
    }
    let deadline = first.arrived_at + MESSAGE_BURST;
    while messages.len() < MAX_BURST_MESSAGES {
        let next = match inbox.try_recv() {
            Ok(message) => Some(message),
            Err(mpsc::error::TryRecvError::Empty) if Instant::now() < deadline => {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    result = tokio::time::timeout_at(deadline, inbox.recv()) => result.ok().flatten(),
                }
            }
            Err(_) => None,
        };
        let Some(next) = next else { break };
        let first = &messages[0];
        let sent_together = first
            .sent_at
            .zip(next.sent_at)
            .is_none_or(|(a, b)| a.abs_diff(b) <= 2000);
        if next.arrived_at > deadline
            || !sent_together
            || next.to_muse
            || next.text.starts_with('/')
            || next.scope != first.scope
            || next.target != first.target
            || next.member != first.member
        {
            *pending = Some(next);
            break;
        }
        messages.push(next);
    }
    messages
}

async fn conversation<'a>(
    conversations: &'a mut HashMap<String, Conversation>,
    ctx: &Context<'_>,
    app_id: &str,
    target: Destination<'_>,
) -> Result<&'a mut Conversation> {
    use std::collections::hash_map::Entry;
    match conversations.entry(target.id.into()) {
        Entry::Occupied(entry) => Ok(entry.into_mut()),
        Entry::Vacant(entry) => {
            let record =
                Conversation::open(ctx, target.scope.conversation_channel(), app_id, target.id)
                    .await?;
            Ok(entry.insert(record))
        }
    }
}
