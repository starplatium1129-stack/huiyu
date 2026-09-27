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
    let description = text(&args["description"]).trim().to_owned();
    if description.is_empty() {
        return Err(Error::plain("缺少画面描述（description）"));
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
    let payload = json!({"character":character,"characterName":name,"description":description,"promptTokens":tokens,"loras":loras,"outfit":outfit,"mature":mature,"createdAt":timestamp,"status":"draft"});
    let bytes = serde_json::to_vec_pretty(&payload).map_err(|_| Error::plain("草稿序列化失败"))?;
    files::atomic(root, &relative, &target, &bytes, cancel).await?;
    Ok(
        json!({"ok":true,"status":"draft","output":format!("已为角色【{name}】保存绘画草稿：“{description}”。尚未提交生成任务，也未生成图片；请在工作台确认后出图。"),"character":character,"draftRelativePath":relative}),
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
