use super::*;
use futures_util::stream::FuturesUnordered;
use std::collections::{HashSet, VecDeque};

const MAX_PRIVATE_TURNS: usize = 4;
const MAX_PENDING: usize = 16;

enum Work {
    Messages(Vec<Message>),
    Notify(String),
}

impl Work {
    fn peer(&self) -> &str {
        match self {
            Self::Messages(messages) => &messages[0].target,
            Self::Notify(peer) => peer,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(in crate::companion_channels::qq) async fn process_private(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    settings: &Settings,
    voice_profile: &str,
    api: &Api,
    cancel: &CancellationToken,
    bindings: &BindingUpdates,
    muse: &mpsc::Sender<Message>,
    mut inbox: mpsc::Receiver<Message>,
) {
    let (voice, voice_auto) = settings.voice_for(QqScope::Private);
    let base = Context {
        app,
        storage,
        principal,
        character: &settings.character,
        chat_provider: settings.chat_provider_for(QqScope::Private),
        is_owner: false,
        owner_bond: crate::chat::ChannelOwnerBond::Default,
        owner_call_name: "",
        owner_note: "",
        drawing: settings.drawing,
        voice,
        voice_auto,
        voice_profile,
        group_member: None,
        cancel,
    };
    let mut pending = VecDeque::new();
    let mut notices = VecDeque::new();
    let mut busy = HashSet::new();
    let mut running = FuturesUnordered::new();
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    while is_current(app, storage) && !cancel.is_cancelled() {
        let mut deadline = None;
        let mut checking_delivery = false;
        while running.len() < MAX_PRIVATE_TURNS {
            let (messages, next) = take_ready(&mut pending, &busy, Instant::now());
            deadline = next;
            let work = if let Some(messages) = messages {
                Work::Messages(messages)
            } else if !checking_delivery {
                let Some(peer) = take_notice(&mut notices, &busy, &pending) else {
                    break;
                };
                checking_delivery = true;
                Work::Notify(peer)
            } else {
                break;
            };
            let peer = work.peer().to_owned();
            busy.insert(peer.clone());
            let base = &base;
            running.push(async move {
                handle(work, base, settings, api, bindings, muse).await;
                peer
            });
        }
        let wait_for_burst = async {
            if let Some(deadline) = deadline {
                tokio::time::sleep_until(deadline).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            _ = cancel.cancelled() => return,
            Some(peer) = running.next(), if !running.is_empty() => { busy.remove(&peer); }
            message = inbox.recv(), if pending.len() < MAX_PENDING => {
                let Some(message) = message else { return };
                pending.push_back(message);
            }
            _ = wait_for_burst, if running.len() < MAX_PRIVATE_TURNS => {}
            _ = tick.tick() => {
                if notices.is_empty() {
                    let bindings = bindings.borrow();
                    notices.extend(bindings.owner.iter().cloned());
                    notices.extend(bindings.friends.iter().map(|friend| friend.id.clone()));
                }
            }
        }
    }
}

fn take_notice(
    notices: &mut VecDeque<String>,
    busy: &HashSet<String>,
    pending: &VecDeque<Message>,
) -> Option<String> {
    let index = notices.iter().position(|peer| {
        !busy.contains(peer) && pending.iter().all(|message| &message.target != peer)
    })?;
    notices.remove(index)
}

fn take_ready(
    queue: &mut VecDeque<Message>,
    busy: &HashSet<String>,
    now: Instant,
) -> (Option<Vec<Message>>, Option<Instant>) {
    let mut next_deadline = None;
    let mut checked = HashSet::new();
    for (index, first) in queue.iter().enumerate() {
        if busy.contains(&first.target) || !checked.insert(first.target.as_str()) {
            continue;
        }
        let deadline = first.arrived_at + MESSAGE_BURST;
        let mut positions = vec![index];
        let mut ready = first.to_muse || first.text.starts_with('/') || now >= deadline;
        if !first.to_muse && !first.text.starts_with('/') {
            for (index, message) in queue.iter().enumerate().skip(index + 1) {
                if message.target != first.target {
                    continue;
                }
                if !same_burst(first, message, deadline) {
                    ready = true;
                    break;
                }
                positions.push(index);
                if positions.len() == MAX_BURST_MESSAGES {
                    ready = true;
                    break;
                }
            }
        }
        if ready {
            let mut messages: Vec<_> = positions
                .into_iter()
                .rev()
                .filter_map(|index| queue.remove(index))
                .collect();
            messages.reverse();
            return (Some(messages), None);
        }
        next_deadline = Some(next_deadline.map_or(deadline, |next: Instant| next.min(deadline)));
    }
    (None, next_deadline)
}

async fn handle(
    work: Work,
    base: &Context<'_>,
    settings: &Settings,
    api: &Api,
    bindings: &BindingUpdates,
    muse: &mpsc::Sender<Message>,
) {
    if let Work::Messages(messages) = &work
        && let Some((kind, code)) = messages[0].pairing_request()
    {
        let message = &messages[0];
        if kind.scope() == QqScope::Private {
            let outcome = pair(
                base.app,
                base.storage,
                base.principal,
                &settings.id,
                &settings.app_id,
                kind,
                &message.target,
                &message.member,
                code,
            )
            .await;
            let notice = match outcome {
                Ok(Some(confirmation)) => confirmation,
                Ok(None) => "配对码已失效，请向机主索取新的配对码。",
                Err(_) => "刚才没能完成绑定，请稍后重试。",
            };
            let _ = api.text(message.destination(), &message.id, notice).await;
        }
        return;
    }

    let peer = work.peer().to_owned();
    let target = Destination {
        scope: QqScope::Private,
        id: &peer,
    };
    let mut live = bindings.subscribe();
    let Some(is_owner) = live.borrow().private_role(target.id) else {
        return;
    };
    let cancel = base.cancel.child_token();
    let _guard = cancel.clone().drop_guard();
    let mut ctx = Context {
        is_owner,
        cancel: &cancel,
        ..*base
    };
    if is_owner {
        ctx.owner_bond = settings.owner_bond_kind();
        ctx.owner_call_name = &settings.owner_call_name;
        ctx.owner_note = &settings.owner_note;
    }
    let turn = async {
        let work = match work {
            Work::Messages(messages) if messages[0].to_muse => {
                // The mailbox checks the current owner again against saved settings.
                if is_owner && let Some(message) = messages.into_iter().next() {
                    let _ = muse.send(message).await;
                }
                return;
            }
            work => work,
        };
        // Preserve the legacy owner record and isolate the same account's
        // friend history even after promotion or replacement of the owner.
        let channel = if is_owner { "qq" } else { "qq-friend" };
        let Ok(mut active) = Conversation::open(&ctx, channel, &settings.app_id, target.id).await
        else {
            return;
        };
        match work {
            Work::Messages(messages) => reply(&ctx, api, &mut active, &messages).await,
            Work::Notify(_) => notify(&ctx, api, &mut active, target, None).await,
        }
    };
    tokio::select! {
        biased;
        _ = live.wait_for(|binding| binding.private_role(target.id) != Some(is_owner)) => {}
        _ = cancel.cancelled() => {}
        _ = turn => {}
    }
}
