use crate::{AppState, error::{ApiError, Result}};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::{LazyLock, Mutex}, time::Duration};
use tokio_util::sync::CancellationToken;

const FUSE_TIMEOUT_SECS: u64 = 14;
const MAX_PROMPT_UTF16: usize = 12_000;
const MAX_CACHE_ENTRIES: usize = 64;

static FUSE_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FuseCastMember {
    #[serde(default)]
    pub(crate) slot: String,
    #[serde(default)]
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) identity: String,
    #[serde(default)]
    pub(crate) outfit_mode: String,
    #[serde(default)]
    pub(crate) outfit: String,
    #[serde(default)]
    pub(crate) action: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FuseCastInput {
    pub(crate) draft_prompt: String,
    #[serde(default)]
    pub(crate) cast: Vec<FuseCastMember>,
    #[serde(default)]
    pub(crate) interaction: Option<String>,
    #[serde(default)]
    pub(crate) user_description: Option<String>,
    #[serde(default)]
    pub(crate) reference_scene: Option<String>,
}

pub(crate) struct FuseOutcome {
    pub(crate) fused: bool,
    pub(crate) prompt: String,
    pub(crate) provider: Option<&'static str>,
    pub(crate) model: Option<String>,
    pub(crate) cache_hit: bool,
    pub(crate) reason: Option<&'static str>,
}

const SYSTEM_FUSE_MOSS: &str = concat!(
    "You are a prompt compiler for MOSS-Image layout-to-image generation. ",
    "Given a draft MOSS layout JSON (with fixed items and bounding boxes) plus the intended cast roster, ",
    "outfits, interactions, and scene notes, rewrite ONLY \"summary.caption\" and each item's \"caption\" ",
    "into fluent, natural, 100% mutually consistent English so MOSS renders every character accurately with ",
    "ZERO trait bleeding and ZERO outfit bleeding.\n",
    "Rules:\n",
    "1. Translate any Chinese instructions (interactions, actions, custom outfits, scene notes) into natural English.\n",
    "2. Keep the EXACT same number and order of items as the input items array.\n",
    "3. In \"summaryCaption\": open with one clear overview stating the exact number of characters and each ",
    "character's spatial slot, name, key hair/eye traits, and exact outfit, followed by their shared interaction ",
    "and pure scene/lighting/camera atmosphere. NEVER leak traits or clothing from one character onto another.\n",
    "4. For each \"character\" item caption: start with its spatial slot, bind that character's exact name, ",
    "hair/eye/species traits, and exact outfit immediately in the first sentence, then state their local pose, ",
    "expression, and action cleanly. If outfitMode is \"explicit\", use ONLY the specified outfit and remove ",
    "any conflicting clothing from the draft. If outfitMode is \"reference\", keep the exact reference clothing ",
    "from the draft prominently bound to the character. If outfitMode is \"none\", do not add default clothing.\n",
    "5. For \"object\" and \"text\" items: keep captions concise and faithful; never alter visible text.\n",
    "6. Faithfully preserve all intended themes and ratings (including SFW, swimwear, lingerie, and NSFW/R18) ",
    "without censoring or softening.\n",
    "7. Return ONLY a raw JSON object with no Markdown or commentary: ",
    "{\"summaryCaption\":\"...\",\"itemCaptions\":[\"...\", ...]}"
);

pub(super) async fn fuse_cast_http(
    State(app): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<FuseCastInput>,
) -> Result<Json<Value>> {
    if input.draft_prompt.trim().is_empty() || input.draft_prompt.len() > 24_000 {
        return Err(ApiError::invalid("draftPrompt 不能为空且不能超过 24000 字节"));
    }
    let cancel = app.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    let outcome = fuse_moss_cast(&app, &headers, input, &cancel).await;
    Ok(Json(json!({
        "ok": true,
        "fused": outcome.fused,
        "prompt": outcome.prompt,
        "provider": outcome.provider,
        "model": outcome.model,
        "cacheHit": outcome.cache_hit,
        "reason": outcome.reason,
    })))
}

pub(crate) async fn fuse_moss_cast(
    app: &AppState,
    headers: &HeaderMap,
    input: FuseCastInput,
    parent: &CancellationToken,
) -> FuseOutcome {
    let fallback = |reason: &'static str| FuseOutcome {
        fused: false,
        prompt: input.draft_prompt.clone(),
        provider: None,
        model: None,
        cache_hit: false,
        reason: Some(reason),
    };
    let Ok(mut draft) = serde_json::from_str::<Value>(input.draft_prompt.trim()) else {
        return fallback("invalid_draft_json");
    };
    let Some(item_count) = draft
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::len)
        .filter(|&n| (1..=16).contains(&n))
    else {
        return fallback("invalid_draft_items");
    };
    let Some(chat) = app.chat.as_ref() else {
        return fallback("chat_unavailable");
    };
    let Some(route) = chat.vision_route(app, headers).await else {
        return fallback("no_api_route");
    };
    let provider = route.provider();
    let model = route.model().to_owned();
    let cache_key = fuse_cache_key(&route.cache_identity(), &input);
    if let Some(cached) = FUSE_CACHE.lock().ok().and_then(|map| map.get(&cache_key).cloned()) {
        return FuseOutcome {
            fused: true,
            prompt: cached,
            provider: Some(provider),
            model: Some(model),
            cache_hit: true,
            reason: None,
        };
    }

    let user_payload = json!({
        "draftLayout": draft,
        "cast": input.cast,
        "interaction": input.interaction,
        "userDescription": input.user_description,
        "referenceScene": input.reference_scene,
    });
    let messages = vec![
        json!({"role": "system", "content": SYSTEM_FUSE_MOSS}),
        json!({"role": "user", "content": user_payload.to_string()}),
    ];
    let cancel = parent.child_token();
    let _guard = cancel.clone().drop_guard();
    let timeout = Duration::from_secs(FUSE_TIMEOUT_SECS);
    let reply = tokio::select! {
        biased;
        _ = cancel.cancelled() => return fallback("cancelled"),
        res = tokio::time::timeout(timeout, chat.vision_complete(app, route, messages, &cancel)) => match res {
            Ok(Ok(text)) => text,
            Ok(Err(_)) => return fallback("upstream_error"),
            Err(_) => return fallback("timeout"),
        }
    };
    let Some((summary_caption, item_captions)) = parse_fuse_reply(&reply, item_count) else {
        return fallback("invalid_reply");
    };

    if let Some(summary) = draft.get_mut("summary").and_then(Value::as_object_mut) {
        summary.insert("caption".into(), json!(summary_caption));
    } else {
        return fallback("invalid_draft_summary");
    }
    if let Some(items) = draft.get_mut("items").and_then(Value::as_array_mut) {
        for (item, new_caption) in items.iter_mut().zip(item_captions) {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("caption".into(), json!(new_caption));
            }
        }
    }
    let Ok(rendered) = serde_json::to_string_pretty(&draft) else {
        return fallback("serialize_error");
    };
    if rendered.encode_utf16().count() > MAX_PROMPT_UTF16 {
        return fallback("prompt_too_long");
    }
    if let Ok(mut cache) = FUSE_CACHE.lock() {
        if cache.len() >= MAX_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(cache_key, rendered.clone());
    }
    FuseOutcome {
        fused: true,
        prompt: rendered,
        provider: Some(provider),
        model: Some(model),
        cache_hit: false,
        reason: None,
    }
}

fn fuse_cache_key(route_id: &str, input: &FuseCastInput) -> String {
    let mut hasher = Sha256::new();
    hasher.update(route_id.as_bytes());
    hasher.update(b"\0");
    if let Ok(bytes) = serde_json::to_vec(input) {
        hasher.update(bytes);
    }
    format!("{:x}", hasher.finalize())
}

fn parse_fuse_reply(content: &str, expected_items: usize) -> Option<(String, Vec<String>)> {
    let trimmed = content.trim_start_matches('\u{feff}').trim();
    let json_text = if let Some(stripped) = trimmed.strip_prefix("```") {
        let (_, body) = stripped.split_once('\n')?;
        let end = body.rfind("```")?;
        body[..end].trim()
    } else if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}'))
        && start < end
    {
        &trimmed[start..=end]
    } else {
        trimmed
    };
    let Value::Object(map) = serde_json::from_str::<Value>(json_text).ok()? else {
        return None;
    };
    let summary = map.get("summaryCaption")?.as_str()?.trim();
    if summary.is_empty() || summary.chars().count() > 4000 || looks_like_refusal(summary) {
        return None;
    }
    let raw_items = map.get("itemCaptions")?.as_array()?;
    if raw_items.len() != expected_items {
        return None;
    }
    let mut items = Vec::with_capacity(expected_items);
    for entry in raw_items {
        let text = entry.as_str()?.trim();
        if text.is_empty() || text.chars().count() > 1500 || looks_like_refusal(text) {
            return None;
        }
        items.push(text.to_owned());
    }
    Some((summary.to_owned(), items))
}

fn looks_like_refusal(text: &str) -> bool {
    let lower = text.to_ascii_lowercase().replace('’', "'");
    [
        "i can't",
        "i cannot",
        "i'm unable",
        "i am unable",
        "i won't",
        "i'm sorry",
        "sorry,",
        "as an ai",
        "i must decline",
        "无法",
        "抱歉",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}
