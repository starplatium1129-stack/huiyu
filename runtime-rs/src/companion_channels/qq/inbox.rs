use super::replies::{notify, reply};
use super::*;

mod private;
pub(super) use private::process_private;

const MESSAGE_BURST: Duration = Duration::from_millis(1400);
const MAX_BURST_MESSAGES: usize = 4;

#[allow(clippy::too_many_arguments)]
pub(super) async fn process(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    settings: Settings,
    voice_profile: &str,
    api: &Api,
    cancel: &CancellationToken,
    bindings: &BindingUpdates,
    mut inbox: mpsc::Receiver<Message>,
) {
    let scope = QqScope::Group;
    let (voice, voice_auto) = settings.voice_for(scope);
    let ctx = Context {
        app,
        storage,
        principal,
        character: &settings.character,
        chat_provider: settings.chat_provider_for(scope),
        is_owner: false,
        owner_bond: settings.owner_bond_kind(),
        owner_call_name: &settings.owner_call_name,
        owner_note: &settings.owner_note,
        drawing: settings.group_drawing,
        voice,
        voice_auto,
        voice_profile,
        group_member: None,
        cancel,
    };
    let mut conversations = HashMap::<String, Conversation>::new();
    for group in &settings.groups {
        let target = Destination { scope, id: &group.id };
        if let Ok(active) = conversation(&mut conversations, &ctx, &settings.app_id, target).await {
            let recent: Vec<_> = active.recent_replies().collect();
            for text in recent.into_iter().rev() {
                api.quotes.restore_text(target.id, text);
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
                if let Some((kind, code)) = message.pairing_request() {
                    if kind == QqPairKind::Group
                        && let Ok(Some(confirmation)) = pair(app, storage, principal, &settings.id, &settings.app_id, kind, target.id, &message.member, code).await
                    {
                        let _ = api.text(target, &message.id, confirmation).await;
                    }
                    continue;
                }
                if !bindings.borrow().allows(target) { continue; }
                let group = collect_burst(message, &mut inbox, &mut pending, cancel).await;
                let message = &group[0];
                let target = message.destination();
                let is_owner = bindings.borrow().groups
                    .iter().find(|group| group.id == target.id)
                    .is_some_and(|group| group.owner_member_id.as_deref() == Some(message.member.as_str()));
                let turn = Context {
                    is_owner,
                    group_member: Some(message.member.as_str()),
                    ..ctx
                };
                let Ok(active) = conversation(&mut conversations, &turn, &settings.app_id, target).await else { continue };
                reply(&turn, api, active, &group).await;
            }
            _ = tick.tick() => {
                let groups = bindings.borrow().groups.clone();
                for group in &groups {
                    let target = Destination { scope, id: &group.id };
                    if let Ok(active) = conversation(&mut conversations, &ctx, &settings.app_id, target).await {
                        notify(&ctx, api, active, target, Some(group)).await;
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
        if !same_burst(first, &next, deadline) {
            *pending = Some(next);
            break;
        }
        messages.push(next);
    }
    messages
}

fn same_burst(first: &Message, next: &Message, deadline: Instant) -> bool {
    next.arrived_at <= deadline
        && first.sent_at.zip(next.sent_at).is_none_or(|(a, b)| a.abs_diff(b) <= 2000)
        && !next.to_muse
        && !next.text.starts_with('/')
        && next.scope == first.scope
        && next.target == first.target
        && next.member == first.member
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
