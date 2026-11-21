use super::*;
use crate::generation::RateLimit;

pub struct RemoteAccess {
    pub(super) content: Arc<RemoteContent>,
    chat: RateLimit,
    translate: RateLimit,
    tts: RateLimit,
    prepare: RateLimit,
}
impl RemoteAccess {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self::with_content(Arc::new(RemoteContent::new(config, shutdown)))
    }
    pub(super) fn with_content(content: Arc<RemoteContent>) -> Self {
        Self {
            content,
            chat: RateLimit::with("聊天", 10, 3000),
            translate: RateLimit::with("翻译", 40, 1000),
            tts: RateLimit::with("语音合成", 40, 1000),
            prepare: RateLimit::with("声线预热", 12, 2000),
        }
    }
    pub async fn guard(
        &self,
        token: &str,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        peer: IpAddr,
    ) -> Option<Response> {
        if let Some(response) = token_guard(token, method, uri, headers, peer) {
            return Some(response);
        }
        if security::is_direct_local(headers, peer) {
            return None;
        }
        let path = uri.path().trim_end_matches('/');
        if let Some(response) = self.content.serve(method, uri, headers, peer).await {
            return Some(response);
        }
        if matches!(*method, Method::GET | Method::HEAD) {
            if crate::upstream::READ_PATHS.contains(&path) {
                return None;
            }
            if paths::public_shell(uri.path())
                || [
                    "/api/health",
                    "/api/chat-status",
                    "/api/tts-status",
                    "/api/sd-status",
                    "/api/video-ai/status",
                    "/api/live2d-status",
                    "/api/live2d-companions",
                    "/api/maintenance/home-hero",
                ]
                .contains(&path)
            {
                return None;
            }
            if path == "/api/tts" || path == "/api/tts-stream" {
                return self.tts.check(false);
            }
            if provider_path(path, method) {
                return None;
            }
        }
        if *method == Method::POST {
            let rate = match path {
                "/api/chat" => Some(&self.chat),
                "/api/translate" => Some(&self.translate),
                "/api/tts" => Some(&self.tts),
                "/api/voice/prepare" => Some(&self.prepare),
                _ => None,
            };
            if let Some(rate) = rate {
                return rate.check(false);
            }
        }
        // App-level generation owns its own rate bucket and the shared-token
        // job owner. Workspace tasks never use that owner or shared authority.
        if provider_path(path, method) {
            return None;
        }
        Some(ApiError::new(403, "LOCAL_ONLY", "此接口仅供本机工作室访问").into_response())
    }
}
fn provider_path(path: &str, method: &Method) -> bool {
    let parts: Vec<_> = path.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() < 3
        || parts[0] != "api"
        || !["generation", "anima", "creative", "video"].contains(&parts[1])
    {
        return false;
    }
    match (method.as_str(), &parts[2..]) {
        ("GET" | "HEAD", ["status"]) => true,
        ("POST", ["jobs"]) => true,
        ("POST", ["images"]) => parts[1] != "generation",
        ("POST", ["images", "raw"]) => matches!(parts[1], "anima" | "creative" | "video"),
        ("GET" | "HEAD" | "DELETE", ["jobs", id]) => !id.is_empty(),
        ("GET" | "HEAD", ["jobs", id, "result"]) => !id.is_empty(),
        ("GET" | "HEAD" | "DELETE", ["requests", key]) => {
            matches!(parts[1], "anima" | "creative" | "video") && !key.is_empty()
        }
        ("POST", ["batches"]) => parts[1] == "video",
        ("GET" | "HEAD" | "DELETE", ["batch-requests", key]) => {
            parts[1] == "video" && !key.is_empty()
        }
        ("GET" | "HEAD" | "DELETE", ["batches", id]) => parts[1] == "video" && !id.is_empty(),
        ("GET" | "HEAD", ["batches", id, "result"]) => parts[1] == "video" && !id.is_empty(),
        ("POST", ["batches", id, "concat"]) => parts[1] == "video" && !id.is_empty(),
        ("POST", ["batches", id, "retry"]) => parts[1] == "video" && !id.is_empty(),
        _ => false,
    }
}
