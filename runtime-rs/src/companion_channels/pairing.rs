use super::{
    AppState, QqFriend, QqGroup, QqPairKind, Result, Storage, read_bots, write_bots,
};

#[allow(clippy::too_many_arguments)]
pub(super) async fn pair(
    app: &AppState,
    storage: &Storage,
    principal: &str,
    bot_id: &str,
    app_id: &str,
    kind: QqPairKind,
    target: &str,
    member_id: &str,
    code: &str,
) -> Result<Option<&'static str>> {
    let _lock = app.channels.write.lock().await;
    if !is_current(app, storage) {
        return Ok(None);
    }
    let mut bots = read_bots(app, storage, principal).await?;
    let Some(bot) = bots
        .iter_mut()
        .find(|bot| bot.id == bot_id && bot.enabled && bot.app_id == app_id)
    else {
        return Ok(None);
    };
    if kind == QqPairKind::Friend && bot.owner.as_deref() == Some(target) {
        return Ok(Some("你已经是我的主人，无需再绑定好友。"));
    }
    let key = (bot_id.to_owned(), kind);
    let label = app
        .channels
        .pairs
        .lock()
        .unwrap()
        .get(&key)
        .filter(|pair| pair.is_current(storage) && pair.code == code)
        .map(|pair| pair.label.clone());
    let Some(label) = label else { return Ok(None) };
    let replaced_owner = kind == QqPairKind::Owner
        && bot.private_muse
        && bot.owner.as_deref().is_some_and(|old| old != target);
    let confirmation = match kind {
        QqPairKind::Owner => {
            bot.owner = Some(target.into());
            bot.friends.retain(|friend| friend.id != target);
            "已绑定绘遇。现在可以直接发消息，或发送 /帮助 查看用法。"
        }
        QqPairKind::Friend => {
            let label = if label.is_empty() {
                let tail = &target[target.len().saturating_sub(6)..];
                format!("好友 · {tail}")
            } else {
                label
            };
            if let Some(friend) = bot.friends.iter_mut().find(|friend| friend.id == target) {
                friend.label = label;
            } else {
                bot.friends.push(QqFriend {
                    id: target.into(),
                    label,
                });
            }
            "已通过好友绑定，现在可以直接和我聊天啦。"
        }
        QqPairKind::Group => {
            if let Some(group) = bot.groups.iter_mut().find(|group| group.id == target) {
                if !label.is_empty() {
                    group.label = label;
                }
                group.owner_member_id = Some(member_id.into());
            } else {
                let tail = &target[target.len().saturating_sub(6)..];
                bot.groups.push(QqGroup {
                    id: target.into(),
                    label: if label.is_empty() {
                        format!("QQ群 · {tail}")
                    } else {
                        label
                    },
                    owner_member_id: Some(member_id.into()),
                });
            }
            "本群已绑定绘遇，已记住你的主人身份。@ 我就能聊天，也可以 @ 我发 /帮助。"
        }
    };
    let binding = bot.clone();
    let _admission = app.host.admit()?;
    write_bots(app, storage, principal, &bots).await?;
    app.channels.update_qq_bindings(&binding);
    if replaced_owner {
        app.channels.close_muse_qq();
        app.channels.updates.notify_one();
    }
    app.channels.pairs.lock().unwrap().remove(&key);
    Ok(Some(confirmation))
}

pub(super) fn is_current(app: &AppState, storage: &Storage) -> bool {
    app.host.check_available().is_ok()
        && app
            .host
            .storage()
            .is_some_and(|value| value.runtime_epoch() == storage.runtime_epoch())
}
