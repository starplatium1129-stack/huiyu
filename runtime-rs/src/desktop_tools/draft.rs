use super::{Error, Result, files, paths, text};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

pub(super) async fn prepare(
    root: &Path,
    args: &Value,
    adult_enabled: bool,
    cancel: &CancellationToken,
) -> Result<Value> {
    let raw = text(&args["character"]);
    let raw = if raw.is_empty() { "natsume" } else { &raw }.to_lowercase();
    let raw = raw.trim();
    if args["outfit"].as_str().is_some_and(|value| {
        value.len() > 100
            || value
                .chars()
                .any(|c| !c.is_ascii_alphanumeric() && !" _.-".contains(c))
    }) {
        return Err(Error::plain(
            "服装请使用已有服装 ID 或英文服装名称，不要加入 LoRA 控制词、权重或提示词脚本。",
        ));
    }
    let description = text(&args["description"]).trim().to_owned();
    if description.is_empty() {
        return Err(Error::plain("缺少画面描述（description）"));
    }
    if description.encode_utf16().count() > 1200 || raw.encode_utf16().count() > 80 {
        return Err(Error::plain("角色 ID 或画面描述超过长度限制"));
    }
    let visual = text(&args["visualDescription"]).trim().to_owned();
    let visual = if visual.is_empty() {
        description.clone()
    } else {
        visual
    };
    if !visual.is_ascii() || !visual.chars().any(|c| c.is_ascii_alphabetic()) || visual.len() > 8000
    {
        return Err(Error::plain(
            "请在 visualDescription 中提供与原意一致的英文画面描述，保留角色、服装和动作；中文说明可继续放在 description 中。当前 Anima 编译不能直接采用中文画面描述。",
        ));
    }
    let character = if raw.contains("natsume") || raw.contains("夏目") {
        "natsume"
    } else if raw.contains("nene") || raw.contains("宁宁") {
        "nene"
    } else {
        raw
    };
    let (mut tokens, loras, name) = match character {
        "natsume" => (
            vec!["shiki_natsume", "1girl", "solo", "mole under right eye"],
            json!([{"id":"L_NAT_V21_ANIMA","strength":0.85}]),
            "四季夏目",
        ),
        "nene" => (
            vec![
                "ayachi_nene",
                "1girl",
                "solo",
                "ahoge",
                "mole under left eye",
            ],
            json!([{"id":"L_NENE_V21_ANIMA","strength":0.85}]),
            "绫地宁宁",
        ),
        other => (vec![other, "1girl", "solo"], json!([]), other),
    };
    let mature = args["outfit"] == "nsfw_nude" || args["mature"] == true;
    if mature {
        if !["nene", "natsume"].contains(&character) {
            return Err(Error::coded(
                "adult_character_not_eligible",
                "该角色未登记为成人内容白名单（fail-closed），已拒绝 R18 参数；请用普通服装重试。",
            ));
        }
        if !adult_enabled {
            return Err(Error::coded(
                "adult_not_enabled",
                "成人内容未获本机授权（adultEnabled !== true），已拒绝 R18 参数；请用普通服装重试。",
            ));
        }
        tokens.extend(["completely naked", "full body bare", "natural skin"]);
    } else if let Some(outfit) = args["outfit"].as_str().filter(|value| !value.is_empty()) {
        tokens.push(outfit);
    }
    tokens.push(&description);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let file_character = encode_character(character);
    let relative = format!("generated-images/companion_{file_character}_{timestamp}.json");
    let target = paths::resolve(root, &relative).await?;
    let outfit = if text(&args["outfit"]).is_empty() {
        json!("default")
    } else {
        args["outfit"].clone()
    };
    let payload = json!({"character":character,"characterName":name,"description":description,"visualDescription":visual,"promptTokens":tokens,"loras":loras,"outfit":outfit,"mature":mature,"createdAt":timestamp,"status":"draft"});
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|_| Error::plain("草稿序列化失败"))?;
    files::atomic(root, &relative, &target, &bytes, cancel).await?;
    Ok(
        json!({"ok":true,"status":"draft","output":format!("已为角色【{name}】保存绘画草稿：“{description}”。聊天中可打开草稿到工作台，确认后生成；当前尚未生成图片。"),"character":character,"draftRelativePath":relative,
          "draft":{"path":relative,"character":character,"description":description}}),
    )
}
fn encode_character(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_'!()*~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded.truncate(encoded.len().min(100));
    encoded
}
