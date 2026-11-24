use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SearchBody {
    request_key: String,
    conversation_id: Option<String>,
    query: String,
}

pub(super) async fn search(
    State(app): State<AppState>,
    Channel(mailbox): Channel,
    Json(body): Json<SearchBody>,
) -> Result<Json<Value>> {
    let _admission = app.host.admit_owned()?;
    let settings = mailbox.settings(&app).await?;
    let entry = if let Some(id) = body.conversation_id {
        if uuid::Uuid::parse_str(&body.request_key).is_err() {
            return Err(ApiError::invalid("主动检索需要 UUID 格式的 requestKey"));
        }
        if !mailbox
            .targets(&settings)
            .iter()
            .any(|target| target.conversation_id == id)
        {
            return Err(ApiError::new(403, "QQ_MUSE_TARGET", "此会话未授权给 Muse"));
        }
        None
    } else {
        let entry = mailbox.entry(&body.request_key)?;
        if !settings.muse_for(entry.scope, entry.destination().id) || !allows(&settings, entry.destination()) {
            return Err(expired());
        }
        Some(entry)
    };
    Ok(Json(
        run(&app, &mailbox, entry.as_deref(), &body.query).await?,
    ))
}

pub(super) async fn run(
    app: &AppState,
    mailbox: &Mailbox,
    entry: Option<&Entry>,
    query: &str,
) -> Result<Value> {
    let mut budget = Duration::from_secs(30);
    if let Some(entry) = entry {
        budget = budget.min(reply_window(app, mailbox, entry)?);
        if let Some(cached) = entry.search.as_ref().and_then(OnceLock::get)
            && cached["ok"] == true
            && cached["query"].as_str() == Some(query.trim())
        {
            return Ok(cached.clone());
        }
    }
    let chat = app
        .chat
        .as_ref()
        .ok_or_else(|| ApiError::new(503, "SEARCH_UNAVAILABLE", "绘遇的网页搜索服务尚未启动"))?;
    let cancel = mailbox.cancel.child_token();
    let _guard = cancel.clone().drop_guard();
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(expired()),
        value = tokio::time::timeout(budget, chat.qq_web_search(query, &cancel)) =>
            value.map_err(|_| ApiError::new(504, "SEARCH_TIMEOUT", "网页检索超时"))?,
    }
}

/// Give text-only Muse clients real sources for explicit searches. Other questions
/// stay intact and the assistant can call /search with its own choice of keywords.
pub(super) fn explicit_query(text: &str) -> Option<&str> {
    let text = text.trim_start().trim_start_matches('请').trim_start();
    let text = text.strip_prefix("帮我").unwrap_or(text).trim_start();
    [
        "/搜索",
        "/search ",
        "联网搜索",
        "上网查一下",
        "上网查查",
        "上网查",
        "查一下",
        "搜寻",
        "搜索",
        "搜一下",
        "搜一搜",
        "搜搜",
        "查一查",
    ]
    .iter()
    .find_map(|prefix| text.strip_prefix(prefix))
    .map(|q| q.trim_start_matches([' ', '：', ':']).trim())
    .filter(|q| !q.is_empty())
}

pub(super) fn with_sources(question: &str, result: &Value) -> String {
    let sources = result["results"].as_array();
    let mut text = format!("{question}\n\n绘遇公开网页检索（以下是来源摘要）：");
    if result["ok"] != true {
        text.push_str(result["error"].as_str().unwrap_or("搜索暂时不可用"));
    } else if let Some(sources) = sources.filter(|items| !items.is_empty()) {
        for item in sources.iter().take(4) {
            let title = item["title"].as_str().unwrap_or("");
            let snippet = item["snippet"].as_str().unwrap_or("");
            let link = item["url"].as_str().unwrap_or("");
            let host = url::Url::parse(link).ok();
            let host = host.as_ref().and_then(|url| url.host_str()).unwrap_or("");
            text.push_str(&format!(
                "\n• {title}（{host}） {}",
                snippet.chars().take(180).collect::<String>()
            ));
        }
    } else {
        text.push_str("没有找到结果。");
    }
    text
}
