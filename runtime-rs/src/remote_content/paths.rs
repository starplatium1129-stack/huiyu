pub const PUBLIC_DATA_FILES: &[&str] = &[
    "scenes.json",
    "scenes-index.json",
    "scenes-core.json",
    "scenes-nene.json",
    "scenes-natsume.json",
    "scenes-shared.json",
    "curation.json",
    "characters.json",
    "loras.json",
    "tags.json",
    "presets.json",
    "popular-characters.json",
    "scene-blueprints.json",
    "character-reference-view.json",
];
const PAGES: &[&str] = &[
    "/",
    "/index.html",
    "/scene-explorer",
    "/popular-scenes",
    "/prompt-builder",
    "/video-studio",
    "/chat",
    "/showcase",
    "/gallery",
    "/character",
    "/style",
    "/lora",
    "/scene-manager",
    "/color-script",
    "/scenario",
    "/companion",
    "/companion-chat",
    "/control",
];

fn normalized(raw: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    let path = decoded.replace('\\', "/");
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    Some(format!("/{}", parts.join("/")))
}
pub(super) fn namespace(raw: &str) -> Option<&'static str> {
    let path = normalized(raw)?;
    let first = path.split('/').nth(1)?;
    ["data", "assets", "character-references", "scene-showcase"]
        .into_iter()
        .find(|name| first.eq_ignore_ascii_case(name))
}
pub fn is_content_path(raw: &str) -> bool {
    namespace(raw).is_some()
}
pub fn is_private_asset_path(raw: &str) -> bool {
    let Some(path) = normalized(raw) else {
        return false;
    };
    let mut parts = path.split('/').skip(1);
    let first = parts.next().unwrap_or("");
    first.eq_ignore_ascii_case("live2d-candidates")
        || first.eq_ignore_ascii_case("assets")
            && parts
                .next()
                .is_some_and(|part| part.eq_ignore_ascii_case("live2d-candidates"))
}
pub(super) fn canonical(raw: &str) -> bool {
    raw.starts_with('/')
        && !raw
            .chars()
            .any(|ch| ch <= '\u{1f}' || "\\%:?#".contains(ch))
        && !raw
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part.starts_with('.'))
        && normalized(raw).as_deref() == Some(raw)
}
pub(super) fn public_shell(raw: &str) -> bool {
    if PAGES.contains(&raw) {
        return true;
    }
    canonical(raw) && (raw.starts_with("/_app/") || ["/favicon.ico", "/favicon.svg"].contains(&raw))
}
