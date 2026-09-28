use crate::{
    AppState,
    error::{ApiError, Result},
    security,
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::HeaderMap,
    routing::post,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::SystemTime,
};

type Catalog = Arc<HashMap<String, Value>>;
struct Cached {
    path: PathBuf,
    modified: Option<SystemTime>,
    size: u64,
    identity: crate::file_identity::Identity,
    values: Catalog,
}
static CACHE: Mutex<Option<Cached>> = Mutex::new(None);
static DIALOGUE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new("「([^「」]+)」").unwrap());
static TITLE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new("^【([^】]+)】").unwrap());
const BEATS: [(&str, &str, &str, &str, &str); 4] = [
    (
        "establishing",
        "wide",
        "still",
        "subtle",
        "Framed as a wide establishing shot of the full scene.",
    ),
    (
        "interaction",
        "medium",
        "still",
        "natural",
        "Framed as a medium shot centered on her action.",
    ),
    (
        "emotion",
        "closeup",
        "push",
        "subtle",
        "Framed as a close-up portrait of her face.",
    ),
    (
        "closing",
        "wide",
        "pull",
        "subtle",
        "Framed as a wide shot as the scenery opens up.",
    ),
];
fn text(value: &Value, fallback: &str) -> String {
    if !crate::generation::truthy(value) {
        return fallback.into();
    }
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| match value {
            Value::Object(_) => "[object Object]".into(),
            Value::Array(items) => items
                .iter()
                .map(|v| text(v, ""))
                .collect::<Vec<_>>()
                .join(","),
            _ => crate::storage::stringify(value),
        })
}
fn build(blueprint: &Value, intent: &Value) -> Value {
    let description = text(&blueprint["description"], "");
    let name = TITLE
        .captures(&description)
        .and_then(|c| c[1].split('·').next().map(|s| s.trim().to_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| text(&blueprint["characterId"], "她"));
    let location = text(&blueprint["location"], &text(&blueprint["title"], "场景"));
    let action = text(&blueprint["action"], "静静伫立");
    let lighting = text(&blueprint["lighting"], "柔和光线");
    let mood = text(&blueprint["mood"], "静谧");
    let day = text(&blueprint["timeOfDay"], "白昼");
    let intent = text(intent, "");
    let mut count = 0;
    let intent: String = intent
        .trim()
        .chars()
        .take_while(|c| {
            count += c.len_utf16();
            count <= 120
        })
        .collect();
    let prose = text(&blueprint["promptProse"], "");
    let prose = if prose.trim().is_empty() {
        description.trim()
    } else {
        prose.trim()
    };
    let dialogue: Vec<_> = DIALOGUE
        .captures_iter(&description)
        .filter(|c| (2..=80).contains(&c[1].encode_utf16().count()))
        .take(2)
        .map(|c| c[1].to_owned())
        .collect();
    let shots:Vec<_>=BEATS.iter().enumerate().map(|(i,(beat,size,camera,motion,framing))|{
        let prompt=match *beat {
            "establishing"=>format!("{location}全景定场。{day}，{lighting}，{mood}的氛围铺满画面，{name}的身影静静出现在场景之中。"),
            // The legacy expression always selects this punctuation; retain its
            // actual compiled text rather than changing prompts during migration.
            "interaction"=>format!("{name}{action}。{}",if intent.is_empty(){String::new()}else{format!("镜头跟随她的动作：{intent}。")}),
            "emotion"=>format!("特写{name}的面庞，{lighting}在她脸上流转，{mood}的神情渐渐清晰{}。",if intent.is_empty(){String::new()}else{format!("，{intent}")}),
            _=>format!("镜头缓缓拉远，{location}重新展开，{day}的光线归于平静，只余{mood}的余韵。"),
        };
        json!({"prompt":prompt,"dialogue":if i==1||i==2{dialogue.get(i-1)}else{None},"shotSize":size,"camera":camera,"motion":motion,"duration":3,"firstFramePrompt":if prose.is_empty(){None}else{Some(format!("{prose} {framing}"))}})
    }).collect();
    json!({"title":text(&blueprint["title"],&text(&blueprint["id"],"undefined")),"blueprintId":text(&blueprint["id"],"undefined"),"characterId":text(&blueprint["characterId"],""),"beats":BEATS.iter().map(|b|b.0).collect::<Vec<_>>(),"shots":shots})
}
fn load(root: &Path) -> Option<Catalog> {
    let path = root.join("data/scene-blueprints.json");
    let metadata = std::fs::metadata(&path).ok()?;
    if metadata.len() > 16 * 1024 * 1024 {
        return None;
    }
    let identity = crate::file_identity::path(&path, false).ok()?;
    let mut cache = CACHE.lock().unwrap();
    if let Some(current) = &*cache
        && current.path == path
        && current.modified == metadata.modified().ok()
        && current.size == metadata.len()
        && current.identity == identity
    {
        return Some(current.values.clone());
    }
    let bytes = std::fs::read(&path).ok()?;
    if bytes.len() > 16 * 1024 * 1024 {
        return None;
    }
    let data: Value = serde_json::from_slice(&bytes).ok()?;
    let values: HashMap<_, _> = data["blueprints"]
        .as_array()?
        .iter()
        .filter_map(|b| b["id"].as_str().map(|id| (id.into(), b.clone())))
        .collect();
    let values = Arc::new(values);
    *cache = Some(Cached {
        path,
        modified: metadata.modified().ok(),
        size: metadata.len(),
        identity,
        values: values.clone(),
    });
    Some(values)
}
pub(super) fn resolve(root: &Path, id: &Value, intent: &Value) -> Result<Value> {
    let id = id
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ApiError::new(400, "INVALID_PARAMETER", "blueprintId 需为字符串"))?;
    let catalog =
        load(root).ok_or_else(|| ApiError::new(404, "UNKNOWN_BLUEPRINT", "未知场景蓝图"))?;
    let blueprint = catalog
        .get(id)
        .ok_or_else(|| ApiError::new(404, "UNKNOWN_BLUEPRINT", "未知场景蓝图"))?;
    // Explicit rating fields cannot bypass the video lane through a benign category.
    if blueprint["adult"] == true
        || blueprint["mature"] == true
        || blueprint["rating"] == "R18"
        || matches!(blueprint["category"].as_str(), Some("成人" | "私密写真"))
    {
        return Err(ApiError::new(
            400,
            "ADULT_BLUEPRINT_UNSUPPORTED",
            "成人蓝图暂不支持自动剧本（视频链路成人门控未接入）",
        ));
    }
    Ok(build(blueprint, intent))
}
pub(super) fn router() -> Router<AppState> {
    Router::new().route(
        "/api/video/storyboard",
        post(handle).layer(DefaultBodyLimit::max(4 * 1024)),
    )
}
async fn handle(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<([(String, String); 1], Json<Value>)> {
    if !security::is_direct_local(&headers, peer.ip()) {
        return Err(ApiError::new(
            403,
            "LOCAL_ONLY",
            "场景蓝图仅供本机工作室访问",
        ));
    }
    app.host.check_available()?;
    let root = app.config.content_root();
    let value =
        tokio::task::spawn_blocking(move || resolve(&root, &body["blueprintId"], &body["intent"]))
            .await
            .map_err(|_| ApiError::new(503, "STORYBOARD_UNAVAILABLE", "剧本读取失败"))??;
    Ok((
        [("cache-control".into(), "no-store".into())],
        Json(json!({"ok":true,"storyboard":value})),
    ))
}
