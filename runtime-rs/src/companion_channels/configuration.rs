use super::*;

const MAX_QQ_BOTS: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    name: Option<String>,
    app_id: String,
    secret: Option<String>,
    character: String,
    chat_provider: Option<QqChatProvider>,
    owner_bond: Option<QqOwnerBond>,
    owner_call_name: Option<String>,
    owner_note: Option<String>,
    voice_mode: Option<QqVoiceMode>,
    group_voice: Option<bool>,
    voice_profile: Option<String>,
    enabled: bool,
    drawing: bool,
    group_drawing: Option<bool>,
    group_natural_replies: Option<bool>,
    group_muse: Option<bool>,
    private_muse: Option<bool>,
    group_muse_all: Option<bool>,
    muse_context_limit: Option<usize>,
    muse_proactive: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairLabel {
    label: Option<String>,
}

async fn validate_change(
    app: &AppState,
    bots: &[Settings],
    existing_index: Option<usize>,
    change: Change,
) -> Result<(Settings, bool)> {
    let existing = existing_index.map(|index| &bots[index]);
    let same = existing.filter(|old| old.app_id == change.app_id);
    if !(1..=24).contains(&change.app_id.len())
        || !change.app_id.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ApiError::invalid("QQ AppID 必须为数字"));
    }
    if bots
        .iter()
        .enumerate()
        .any(|(index, bot)| existing_index != Some(index) && bot.app_id == change.app_id)
    {
        return Err(ApiError::invalid(
            "这个 AppID 已经在其他 QQ 机器人里配置过了",
        ));
    }
    let name = match change.name {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.chars().count() > 40 || trimmed.chars().any(char::is_control) {
                return Err(ApiError::invalid("机器人备注最多 40 字，请使用普通文字"));
            }
            trimmed.to_owned()
        }
        None => existing.map(|old| old.name.clone()).unwrap_or_default(),
    };
    let sealed_secret = match change.secret.filter(|value| !value.is_empty()) {
        Some(secret)
            if (8..=512).contains(&secret.len())
                && secret.bytes().all(|byte| byte.is_ascii_graphic()) =>
        {
            secret::seal(&secret)?
        }
        Some(_) => return Err(ApiError::invalid("请检查 QQ 机器人 AppSecret")),
        None => same
            .map(|old| old.sealed_secret.clone())
            .ok_or_else(|| ApiError::invalid("请输入 QQ 机器人 AppSecret"))?,
    };
    let valid_character = matches!(change.character.as_str(), "nene" | "natsume")
        || crate::chat::chat_card_exists(app, &change.character).await;
    if !valid_character {
        return Err(ApiError::invalid("请选择有效的角色或角色卡"));
    }
    let voice_profile = change.voice_profile.unwrap_or_else(|| {
        existing
            .map(|old| old.voice_profile.clone())
            .unwrap_or_else(default_voice_profile)
    });
    if voice_profile != "auto" && !crate::voice::is_valid_voice_id(&voice_profile) {
        return Err(ApiError::invalid("请选择有效的角色声线"));
    }
    let muse_context_limit = change.muse_context_limit.unwrap_or_else(|| {
        same.map_or_else(default_muse_context_limit, |old| old.muse_context_limit)
    });
    if !matches!(muse_context_limit, 6 | 16 | 32 | 64) {
        return Err(ApiError::invalid("请选择 6、16、32 或 64 条群聊前文"));
    }
    let group_muse = change
        .group_muse
        .unwrap_or_else(|| same.is_some_and(|old| old.group_muse));
    let private_muse = change
        .private_muse
        .unwrap_or_else(|| same.is_some_and(|old| old.private_muse));
    if (group_muse || private_muse)
        && bots
            .iter()
            .enumerate()
            .any(|(index, bot)| existing_index != Some(index) && bot.uses_muse())
    {
        return Err(ApiError::invalid(
            "同时只能有一个机器人开启 Muse 协作，请先关闭其他机器人的 Muse 开关",
        ));
    }
    let owner_call_name = match change.owner_call_name {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.chars().count() > 40 || trimmed.chars().any(char::is_control) {
                return Err(ApiError::invalid("对我的称呼最多 40 字，请使用普通文字"));
            }
            trimmed.to_owned()
        }
        None => existing
            .map(|old| old.owner_call_name.clone())
            .unwrap_or_default(),
    };
    let owner_note = match change.owner_note {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.chars().count() > 200
                || trimmed
                    .chars()
                    .any(|ch| ch.is_control() && ch != '\n' && ch != '\r')
            {
                return Err(ApiError::invalid("关系补充最多 200 字，请使用普通文字"));
            }
            trimmed.replace(['\r', '\n'], " ")
        }
        None => existing
            .map(|old| old.owner_note.clone())
            .unwrap_or_default(),
    };
    let id = existing
        .map(|old| old.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()[..12].to_owned());
    let settings = Settings {
        id,
        name,
        app_id: change.app_id,
        sealed_secret,
        character: change.character,
        chat_provider: change
            .chat_provider
            .unwrap_or_else(|| existing.map_or(QqChatProvider::Default, |old| old.chat_provider)),
        owner_bond: change
            .owner_bond
            .unwrap_or_else(|| existing.map_or(QqOwnerBond::Default, |old| old.owner_bond)),
        owner_call_name,
        owner_note,
        voice_mode: change
            .voice_mode
            .unwrap_or_else(|| existing.map_or(QqVoiceMode::Off, |old| old.voice_mode)),
        group_voice: change
            .group_voice
            .unwrap_or_else(|| existing.is_some_and(|old| old.group_voice)),
        voice_profile,
        enabled: change.enabled,
        drawing: change.drawing,
        owner: same.and_then(|old| old.owner.clone()),
        friends: same.map(|old| old.friends.clone()).unwrap_or_default(),
        group_drawing: change
            .group_drawing
            .unwrap_or_else(|| same.is_some_and(|old| old.group_drawing)),
        group_natural_replies: change
            .group_natural_replies
            .unwrap_or_else(|| same.is_some_and(|old| old.group_natural_replies)),
        group_muse,
        private_muse,
        group_muse_all: change
            .group_muse_all
            .unwrap_or_else(|| same.is_some_and(|old| old.group_muse_all)),
        muse_context_limit,
        muse_proactive: change
            .muse_proactive
            .unwrap_or_else(|| same.is_some_and(|old| old.muse_proactive)),
        muse_history_generation: same
            .map(|old| old.muse_history_generation.clone())
            .unwrap_or_default(),
        groups: same.map(|old| old.groups.clone()).unwrap_or_default(),
    };
    let only_muse_depth = same.is_some_and(|old| {
        old.muse_context_limit != muse_context_limit && old.same_connection(&settings)
    });
    Ok((settings, only_muse_depth))
}

pub(crate) async fn configure(
    app: &AppState,
    storage: &Storage,
    session: &Session,
    method: &Method,
    path: &[String],
    body: Bytes,
) -> Result<Value> {
    let principal = principal(app)
        .filter(|value| value == &session.principal_id)
        .ok_or_else(|| ApiError::new(403, "LOCAL_ONLY", "请在绘遇桌面客户端设置手机聊天"))?;
    if body.len() > 8192 {
        return Err(ApiError::invalid("连接设置过长"));
    }
    if path.first().is_some_and(|channel| channel == "wechat") {
        return wechat::configure(app, storage, &principal, method, &path[1..], &body).await;
    }
    let _lock = app.channels.write.lock().await;
    let mut bots = read_bots(app, storage, &principal).await?;
    match (method.as_str(), path) {
        ("GET" | "HEAD", [channel]) if channel == "qq" => Ok(status(app, storage, bots.first())),
        ("GET" | "HEAD", [channel, resource]) if channel == "qq" && resource == "bots" => {
            Ok(bots_response(app, storage, &bots, None))
        }
        ("POST", [channel, resource]) if channel == "qq" && resource == "bots" => {
            if bots.len() >= MAX_QQ_BOTS {
                return Err(ApiError::invalid("最多同时配置 16 个 QQ 机器人"));
            }
            let _admission = app.host.admit()?;
            let change: Change = serde_json::from_slice(&body)?;
            let (mut settings, _) = validate_change(app, &bots, None, change).await?;
            settings.muse_history_generation = uuid::Uuid::new_v4().to_string();
            let created_id = settings.id.clone();
            let created_enabled = settings.enabled;
            let uses_muse = settings.uses_muse();
            bots.push(settings);
            write_bots(app, storage, &principal, &bots).await?;
            if uses_muse {
                app.channels.close_muse_qq();
            }
            app.channels.report(
                storage,
                &created_id,
                if created_enabled {
                    "connecting"
                } else {
                    "disabled"
                },
                None,
            );
            app.channels.updates.notify_one();
            let created = bots.iter().find(|bot| bot.id == created_id);
            Ok(bots_response(app, storage, &bots, created))
        }
        ("PUT", [channel, resource, bot_id]) if channel == "qq" && resource == "bots" => {
            let index = bots
                .iter()
                .position(|bot| bot.id == *bot_id)
                .ok_or_else(|| ApiError::new(404, "BOT_NOT_FOUND", "找不到这个 QQ 机器人"))?;
            let _admission = app.host.admit()?;
            let change: Change = serde_json::from_slice(&body)?;
            let had_muse = bots[index].uses_muse();
            let (mut settings, only_muse_depth) =
                validate_change(app, &bots, Some(index), change).await?;
            if only_muse_depth {
                bots[index] = settings;
                write_bots(app, storage, &principal, &bots).await?;
                return Ok(bots_response(app, storage, &bots, bots.get(index)));
            }
            let same_connection = bots[index].same_connection(&settings);
            let touches_muse = had_muse || settings.uses_muse();
            if !same_connection {
                settings.muse_history_generation = uuid::Uuid::new_v4().to_string();
            }
            let updated_enabled = settings.enabled;
            bots[index] = settings;
            write_bots(app, storage, &principal, &bots).await?;
            if !same_connection {
                if touches_muse {
                    app.channels.close_muse_qq();
                }
                app.channels.clear_pairs(bot_id);
                app.channels.report(
                    storage,
                    bot_id,
                    if updated_enabled {
                        "connecting"
                    } else {
                        "disabled"
                    },
                    None,
                );
                app.channels.updates.notify_one();
            }
            Ok(bots_response(app, storage, &bots, bots.get(index)))
        }
        ("DELETE", [channel, resource, bot_id]) if channel == "qq" && resource == "bots" => {
            let index = bots
                .iter()
                .position(|bot| bot.id == *bot_id)
                .ok_or_else(|| ApiError::new(404, "BOT_NOT_FOUND", "找不到这个 QQ 机器人"))?;
            let _admission = app.host.admit()?;
            let removed = bots.remove(index);
            write_bots(app, storage, &principal, &bots).await?;
            if removed.uses_muse() {
                app.channels.close_muse_qq();
            }
            app.channels.clear_pairs(bot_id);
            app.channels.remove_connection(bot_id);
            app.channels.updates.notify_one();
            Ok(bots_response(app, storage, &bots, None))
        }
        ("POST", [channel, resource, bot_id, action])
            if channel == "qq"
                && resource == "bots"
                && matches!(action.as_str(), "pair" | "pair-group" | "pair-friend") =>
        {
            let bot = bots
                .iter()
                .find(|bot| bot.id == *bot_id)
                .filter(|value| value.enabled)
                .ok_or_else(|| ApiError::invalid("请先保存并启用这个 QQ 机器人"))?;
            let _admission = app.host.admit()?;
            let kind = match action.as_str() {
                "pair-friend" => QqPairKind::Friend,
                "pair-group" => QqPairKind::Group,
                _ => QqPairKind::Owner,
            };
            let label = if kind != QqPairKind::Owner && !body.is_empty() {
                let request: PairLabel = serde_json::from_slice(&body)?;
                let label = request.label.as_deref().unwrap_or_default().trim();
                if label.chars().count() > 40 || label.chars().any(char::is_control) {
                    return Err(ApiError::invalid(if kind == QqPairKind::Friend {
                        "好友备注最多 40 字，请使用普通文字"
                    } else {
                        "群备注最多 40 字，请使用普通文字"
                    }));
                }
                label.to_owned()
            } else {
                String::new()
            };
            let code = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
            app.channels.set_pair(
                &bot.id,
                kind,
                Pairing {
                    epoch: storage.runtime_epoch().into(),
                    code,
                    expires_at: crate::host::now_ms() + 5 * 60_000,
                    label,
                },
            );
            Ok(bots_response(app, storage, &bots, Some(bot)))
        }
        ("DELETE", [channel, resource, bot_id, sub, friend_id])
            if channel == "qq" && resource == "bots" && sub == "friends" =>
        {
            let index = bots
                .iter()
                .position(|bot| bot.id == *bot_id)
                .ok_or_else(|| ApiError::new(404, "BOT_NOT_FOUND", "找不到这个 QQ 机器人"))?;
            let previous = bots[index].friends.len();
            bots[index].friends.retain(|friend| friend.id != *friend_id);
            if bots[index].friends.len() != previous {
                let _admission = app.host.admit()?;
                write_bots(app, storage, &principal, &bots).await?;
                app.channels.update_qq_bindings(&bots[index]);
            }
            Ok(bots_response(app, storage, &bots, bots.get(index)))
        }
        ("DELETE", [channel, resource, bot_id, sub, group_id])
            if channel == "qq" && resource == "bots" && sub == "groups" =>
        {
            let index = bots
                .iter()
                .position(|bot| bot.id == *bot_id)
                .ok_or_else(|| ApiError::new(404, "BOT_NOT_FOUND", "找不到这个 QQ 机器人"))?;
            let _admission = app.host.admit()?;
            let previous = bots[index].groups.len();
            bots[index].groups.retain(|group| group.id != *group_id);
            if bots[index].groups.len() != previous {
                let uses_muse = bots[index].uses_muse();
                bots[index].muse_history_generation = uuid::Uuid::new_v4().to_string();
                write_bots(app, storage, &principal, &bots).await?;
                if uses_muse {
                    app.channels.close_muse_qq();
                }
                app.channels.updates.notify_one();
            }
            Ok(bots_response(app, storage, &bots, bots.get(index)))
        }
        _ => Err(ApiError::new(404, "CHANNEL_ROUTE", "找不到消息连接选项")),
    }
}

fn bots_response(
    app: &AppState,
    storage: &Storage,
    bots: &[Settings],
    selected: Option<&Settings>,
) -> Value {
    let list: Vec<Value> = bots
        .iter()
        .map(|bot| status(app, storage, Some(bot)))
        .collect();
    match selected {
        Some(bot) => json!({ "ok": true, "bot": status(app, storage, Some(bot)), "bots": list }),
        None => json!({ "ok": true, "bots": list }),
    }
}

fn status(app: &AppState, storage: &Storage, settings: Option<&Settings>) -> Value {
    let bot_id = settings.map_or("default", |value| value.id.as_str());
    let connections = app.channels.connections.lock().unwrap();
    let connection = connections.get(bot_id);
    let current = connection
        .is_some_and(|item| item.epoch == storage.runtime_epoch() && !item.phase.is_empty());
    let phase = connection.map_or("", |item| item.phase);
    let detail = connection.and_then(|item| item.detail);
    drop(connections);
    let enabled = settings.is_some_and(|value| value.enabled);
    let (pair_code, pair_expires) = app.channels.pair_code(storage, bot_id, QqPairKind::Owner);
    let (group_code, group_expires) = app.channels.pair_code(storage, bot_id, QqPairKind::Group);
    let (friend_code, friend_expires) = app.channels.pair_code(storage, bot_id, QqPairKind::Friend);
    let muse_status = if !enabled || !settings.is_some_and(Settings::uses_muse) {
        None
    } else {
        Some(
            app.channels
                .muse_qq
                .lock()
                .unwrap()
                .as_ref()
                .map_or("waiting", |m| m.status(app, storage)),
        )
    };
    let groups: Vec<Value> = settings
        .map_or(&[][..], |value| value.groups.as_slice())
        .iter()
        .map(|group| {
            json!({
                "id": group.id,
                "label": group.label,
                "ownerBound": group.owner_member_id.is_some(),
            })
        })
        .collect();
    json!({"ok":true,"id":settings.map(|value| &value.id),"name":settings.map_or("", |value| value.name.as_str()),
        "configured":settings.is_some(),"enabled":enabled,
        "appId":settings.map(|value| &value.app_id),"character":settings.map_or("nene", |value| &value.character),
        "chatProvider":settings.map_or(QqChatProvider::Default, |value| value.chat_provider),
        "ownerBond":settings.map_or(QqOwnerBond::Default, |value| value.owner_bond),
        "ownerCallName":settings.map_or("", |value| value.owner_call_name.as_str()),
        "ownerNote":settings.map_or("", |value| value.owner_note.as_str()),
        "voiceMode":settings.map_or(QqVoiceMode::Off, |value| value.voice_mode),
        "groupVoice":settings.is_some_and(|value| value.group_voice),
        "voiceProfile":settings.map_or("auto", |value| value.voice_profile.as_str()),
        "drawing":settings.is_some_and(|value| value.drawing),"paired":settings.is_some_and(|value| value.owner.is_some()),
        "groupDrawing":settings.is_some_and(|value| value.group_drawing),"groupMuse":settings.is_some_and(|value| value.group_muse),
        "groupNaturalReplies":settings.is_some_and(|value| value.group_natural_replies),
        "privateMuse":settings.is_some_and(|value| value.private_muse),
        "groupMuseAll":settings.is_some_and(|value| value.group_muse_all),
        "museContextLimit":settings.map_or_else(default_muse_context_limit, |value| value.muse_context_limit),
        "museProactive":settings.is_some_and(|value| value.muse_proactive),
        "groupMuseStatus":muse_status,"groups":groups,
        "friends":settings.map_or(&[][..], |value| value.friends.as_slice()),
        "phase":if !enabled { "disabled" } else if current { phase } else { "connecting" },
        "detail":if enabled && current { detail } else { None },
        "pairCode":pair_code,"pairExpiresAt":pair_expires,
        "groupPairCode":group_code,"groupPairExpiresAt":group_expires,
        "friendPairCode":friend_code,"friendPairExpiresAt":friend_expires})
}
