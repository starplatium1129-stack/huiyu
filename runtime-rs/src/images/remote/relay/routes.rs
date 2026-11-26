use reqwest::Method;

fn valid_key(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 180
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn valid_gallery_id(s: &str) -> bool {
    if s.is_empty() || s.len() > 512 || s == "." || s == ".." || s.contains("..") {
        return false;
    }
    let bytes = s.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'%' {
            if i + 2 >= bytes.len() {
                return false;
            }
            let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2])) else {
                return false;
            };
            decoded.push((hi << 4) | lo);
            i += 3;
        } else if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            decoded.push(b);
            i += 1;
        } else {
            return false;
        }
    }
    if decoded.is_empty()
        || decoded
            .iter()
            .any(|&b| b == 0 || b == b'/' || b == b'\\' || b < 0x20 || b == 0x7f)
    {
        return false;
    }
    !decoded.windows(2).any(|w| w == b"..")
}

fn valid_part_query(query: Option<&str>, require_part: bool, allow_id_type: bool) -> bool {
    let Some(query) = query else {
        return !require_part;
    };
    if query.is_empty() {
        return false;
    }
    let mut seen_part = false;
    let mut seen_count = false;
    let mut seen_id_type = false;
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            return false;
        };
        match k {
            "part" => {
                if seen_part
                    || v.is_empty()
                    || !v.bytes().all(|b| b.is_ascii_digit())
                    || v.parse::<u32>().is_err()
                {
                    return false;
                }
                seen_part = true;
            }
            "count" => {
                if seen_count
                    || v.is_empty()
                    || !v.bytes().all(|b| b.is_ascii_digit())
                    || !v.parse::<u8>().is_ok_and(|n| (1..=16).contains(&n))
                {
                    return false;
                }
                seen_count = true;
            }
            "idType" if allow_id_type => {
                if seen_id_type || !matches!(v, "string" | "number") {
                    return false;
                }
                seen_id_type = true;
            }
            _ => return false,
        }
    }
    (!require_part || seen_part) && (!seen_count || seen_part)
}

fn valid_id_type_query(query: Option<&str>) -> bool {
    match query {
        None => true,
        Some("idType=string" | "idType=number") => true,
        _ => false,
    }
}

pub(super) fn qq_message(method: &Method, path: &str) -> bool {
    *method == Method::POST && matches!(path, "/api/muse/qq/reply" | "/api/muse/qq/send")
}

pub(in super::super) fn qq_route(method: &Method, path: &str) -> bool {
    qq_message(method, path)
        || (*method == Method::GET && matches!(path, "/api/muse/qq/inbox" | "/api/muse/qq/targets"))
        || (*method == Method::GET
            && path
                .strip_prefix("/api/muse/qq/context/")
                .is_some_and(|id| {
                    id.len() == 64
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                }))
        || (*method == Method::POST && path == "/api/muse/qq/search")
}

pub(in super::super) fn desktop_chat_route(method: &Method, path: &str) -> bool {
    (*method == Method::GET && path == "/api/muse/desktop/inbox")
        || (*method == Method::POST && path == "/api/muse/desktop/reply")
}

pub(in super::super) fn voice_route(method: &Method, path: &str) -> bool {
    (*method == Method::GET && path == "/api/muse/voice/status")
        || (*method == Method::POST && path == "/api/muse/voice/synthesize")
}

pub(in super::super) fn interrogate_route(method: &Method, path: &str, has_query: bool) -> bool {
    (*method == Method::GET && path == crate::interrogate::muse::STATUS_PATH && !has_query)
        || (*method == Method::POST && path == crate::interrogate::muse::INTERROGATE_PATH)
}

pub(in super::super) fn video_direct_route(method: &Method, path: &str, has_query: bool) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        ["", "api", "muse", "video", "status"] => *method == Method::GET,
        ["", "api", "muse", "video", "prompt", "preview"] => *method == Method::POST && !has_query,
        ["", "api", "muse", "video", "inputs"] => *method == Method::POST,
        ["", "api", "muse", "video", "jobs"] => *method == Method::POST && !has_query,
        ["", "api", "muse", "video", "jobs", id] => {
            (*method == Method::GET || *method == Method::DELETE) && valid_key(id) && !has_query
        }
        ["", "api", "muse", "video", "jobs", id, "result"] => {
            (*method == Method::GET || *method == Method::HEAD) && valid_key(id)
        }
        ["", "api", "muse", "video", "requests", id] => {
            (*method == Method::GET || *method == Method::DELETE) && valid_key(id) && !has_query
        }
        ["", "api", "muse", "video", "batches"] => *method == Method::POST && !has_query,
        ["", "api", "muse", "video", "batches", id] => {
            (*method == Method::GET || *method == Method::DELETE) && valid_key(id) && !has_query
        }
        ["", "api", "muse", "video", "batches", id, "result"] => {
            (*method == Method::GET || *method == Method::HEAD) && valid_key(id)
        }
        ["", "api", "muse", "video", "batches", id, "concat" | "retry"] => {
            *method == Method::POST && valid_key(id) && !has_query
        }
        ["", "api", "muse", "video", "batch-requests", id] => {
            (*method == Method::GET || *method == Method::DELETE) && valid_key(id) && !has_query
        }
        _ => false,
    }
}

pub(in super::super) fn ops_direct_route(method: &Method, path: &str, has_query: bool) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    match parts.as_slice() {
        ["", "api", "muse", "health"] => *method == Method::GET && !has_query,
        ["", "api", "muse", "gallery"] => *method == Method::GET,
        ["", "api", "muse", "gallery", id] => *method == Method::GET && valid_gallery_id(id),
        ["", "api", "muse", "gallery", id, "file"] => {
            (*method == Method::GET || *method == Method::HEAD) && valid_gallery_id(id)
        }
        _ => false,
    }
}

pub(super) fn is_video_concat_route(route: &str) -> bool {
    let parts: Vec<_> = route.split('/').collect();
    matches!(
        parts.as_slice(),
        ["", "api", "muse", "video", "batches", id, "concat"] if valid_key(id)
    )
}

fn valid_image_result_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn is_media_part_route(route: &str) -> bool {
    let parts: Vec<_> = route.split('/').collect();
    match parts.as_slice() {
        ["", "api", "muse", "video", "jobs" | "batches", id, "result"] => valid_key(id),
        ["", "api", "muse", "gallery", id, "file"] => valid_gallery_id(id),
        [
            "",
            "api",
            "anima" | "moss" | "qwen" | "creative" | "keyframe" | "manga",
            "jobs",
            id,
            "result",
        ] => valid_image_result_id(id),
        _ => false,
    }
}

pub(super) fn requires_request_key(method: &Method, route: &str) -> bool {
    if *method != Method::POST {
        return false;
    }
    !matches!(
        route,
        super::super::upload_index::PATH
            | super::super::muse::PREVIEW_PATH
            | "/api/muse/video/prompt/preview"
            | "/api/muse/video/inputs"
    ) && !is_video_concat_route(route)
}

pub(super) fn is_async_media_command(method: &Method, route: &str) -> bool {
    is_media_part_route(route)
        || (*method == Method::POST
            && (matches!(
                route,
                super::super::muse::upscale::UPSCALE_PATH
                    | "/api/muse/batches"
                    | "/api/muse/video/inputs"
                    | "/api/muse/video/batches"
            ) || is_video_concat_route(route)))
}

pub(super) fn allowed(method: &Method, path: &str) -> bool {
    if path.len() > 4096 || path.contains(['#', '\\']) || path.bytes().any(|b| b.is_ascii_control())
    {
        return false;
    }
    if qq_route(method, path) || desktop_chat_route(method, path) || voice_route(method, path) {
        return true;
    }
    let (route, query) = match path.split_once('?') {
        Some((route, query)) => (route, Some(query)),
        None => (path, None),
    };
    if route == super::super::muse::PREVIEW_PATH {
        return *method == Method::POST && query.is_none();
    }
    let parts: Vec<_> = route.split('/').collect();
    match parts.as_slice() {
        ["", "api", "muse", "jobs"] => *method == Method::POST || *method == Method::GET,
        ["", "api", "muse", "batches"] => *method == Method::POST && query.is_none(),
        ["", "api", "muse", "upscale"] => *method == Method::POST && query.is_none(),
        ["", "api", "muse", "inputs", "lookup"] => *method == Method::POST && query.is_none(),
        ["", "api", "muse", "interrogate", "status"] => *method == Method::GET && query.is_none(),
        ["", "api", "muse", "interrogate"] => *method == Method::POST && query.is_none(),
        ["", "api", "muse", "guide" | "queue" | "catalog" | "options"] => *method == Method::GET,
        ["", "api", "muse", "health"] => *method == Method::GET && query.is_none(),
        ["", "api", "muse", "gallery"] => *method == Method::GET,
        ["", "api", "muse", "gallery", id] => {
            *method == Method::GET && valid_gallery_id(id) && valid_id_type_query(query)
        }
        ["", "api", "muse", "gallery", id, "file"] => {
            valid_gallery_id(id)
                && ((*method == Method::GET && valid_part_query(query, true, true))
                    || (*method == Method::HEAD && valid_part_query(query, false, true)))
        }
        ["", "api", "muse", "video", "status"] => *method == Method::GET,
        ["", "api", "muse", "video", "prompt", "preview"] => {
            *method == Method::POST && query.is_none()
        }
        ["", "api", "muse", "video", "inputs"] => *method == Method::POST,
        ["", "api", "muse", "video", "jobs"] => *method == Method::POST && query.is_none(),
        ["", "api", "muse", "video", "jobs", id] => {
            (*method == Method::GET || *method == Method::DELETE)
                && valid_key(id)
                && query.is_none()
        }
        ["", "api", "muse", "video", "jobs", id, "result"] => {
            valid_key(id)
                && ((*method == Method::GET && valid_part_query(query, true, false))
                    || (*method == Method::HEAD && valid_part_query(query, false, false)))
        }
        ["", "api", "muse", "video", "requests", id] => {
            (*method == Method::GET || *method == Method::DELETE)
                && valid_key(id)
                && query.is_none()
        }
        ["", "api", "muse", "video", "batches"] => *method == Method::POST && query.is_none(),
        ["", "api", "muse", "video", "batches", id] => {
            (*method == Method::GET || *method == Method::DELETE)
                && valid_key(id)
                && query.is_none()
        }
        ["", "api", "muse", "video", "batches", id, "result"] => {
            valid_key(id)
                && ((*method == Method::GET && valid_part_query(query, true, false))
                    || (*method == Method::HEAD && valid_part_query(query, false, false)))
        }
        ["", "api", "muse", "video", "batches", id, "concat" | "retry"] => {
            *method == Method::POST && valid_key(id) && query.is_none()
        }
        ["", "api", "muse", "video", "batch-requests", id] => {
            (*method == Method::GET || *method == Method::DELETE)
                && valid_key(id)
                && query.is_none()
        }
        [
            "",
            "api",
            "anima" | "moss" | "qwen" | "creative" | "keyframe" | "manga",
            "status",
        ] => *method == Method::GET && query.is_none(),
        [
            "",
            "api",
            "muse",
            "catalog",
            "character" | "scene" | "blueprint" | "outfit",
            ids @ ..,
        ] => *method == Method::GET && !ids.is_empty() && ids.iter().all(|id| valid_key(id)),
        ["", "api", "muse", "batches", ids @ ..] => {
            (*method == Method::GET || *method == Method::DELETE)
                && (1..=2).contains(&ids.len())
                && ids.iter().all(|id| valid_key(id))
        }
        [
            "",
            "api",
            "anima" | "moss" | "qwen" | "creative" | "keyframe" | "manga",
            "jobs" | "requests",
            id,
        ] => (*method == Method::GET || *method == Method::DELETE) && valid_key(id),
        [
            "",
            "api",
            "anima" | "moss" | "qwen" | "creative" | "keyframe" | "manga",
            "jobs",
            id,
            "result",
        ] => {
            *method == Method::GET
                && valid_image_result_id(id)
                && valid_part_query(query, true, false)
        }
        _ => false,
    }
}
