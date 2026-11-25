use crate::{config::Config, download_transport};
use reqwest::{StatusCode, header::CONTENT_RANGE};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

pub(super) const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/starplatium1129-stack/huiyu/releases/latest/download/media-packs.json";
pub(super) const DEFAULT_PORTRAITS_ESTIMATE: u64 = 436_500_000;
pub(super) const DEFAULT_SHOWCASE_ESTIMATE: u64 = 1_650_000_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackSettings {
    #[serde(default)]
    pub mirror_origin: String,
    #[serde(default)]
    pub manifest_url: String,
    #[serde(default)]
    pub onboarding_dismissed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InstalledRecord {
    pub(super) version: String,
    pub(super) sha256: String,
    pub(super) bytes: u64,
    pub(super) file_count: usize,
    pub(super) installed_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteArchive {
    #[serde(default)]
    pub(super) file_name: String,
    pub(super) url: String,
    pub(super) sha256: String,
    pub(super) bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemotePack {
    pub(super) id: String,
    pub(super) version: String,
    #[serde(default)]
    pub(super) label: String,
    #[serde(default)]
    pub(super) description: String,
    #[serde(default)]
    pub(super) bytes: u64,
    #[serde(default)]
    pub(super) file_count: usize,
    pub(super) archive: RemoteArchive,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteIndex {
    #[serde(default)]
    pub(super) updated_at: String,
    #[serde(default)]
    pub(super) packs: HashMap<String, RemotePack>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TaskState {
    pub(super) id: String,
    pub(super) state: String, // running | cancelling | completed | failed | cancelled
    pub(super) pack_id: Option<String>,
    pub(super) queue: Vec<String>,
    pub(super) completed_packs: Vec<String>,
    pub(super) phase: String, // fetching-index | downloading | verifying | extracting | switching
    pub(super) bytes: u64,
    pub(super) total: u64,
    pub(super) files_done: usize,
    pub(super) files_total: usize,
    pub(super) speed_bps: u64,
    pub(super) mirror_label: String,
    pub(super) message: String,
    pub(super) error: Option<String>,
    pub(super) started_at: u64,
    pub(super) finished_at: u64,
}

#[derive(Default)]
pub(super) struct Inner {
    pub(super) closed: bool,
    pub(super) task: Option<TaskState>,
    pub(super) cancel: Option<CancellationToken>,
    pub(super) remote_index: Option<RemoteIndex>,
    pub(super) remote_fetched_at: Option<Instant>,
    pub(super) remote_error: Option<String>,
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(super) fn storage_root(config: &Config) -> PathBuf {
    if config.is_packaged()
        && let Some(parent) = config.runtime_root.parent()
    {
        return parent.join("media-packs");
    }
    config.runtime_root.join("media-packs")
}

pub(super) fn valid_http_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return true;
    }
    url::Url::parse(trimmed)
        .ok()
        .is_some_and(|u| matches!(u.scheme(), "https" | "http") && u.host_str().is_some())
}

pub(super) fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

pub(super) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "缺少保存目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    let mut tmp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("创建保存文件失败：{e}"))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("序列化失败：{e}"))?;
    tmp.write_all(&bytes)
        .map_err(|e| format!("写入文件失败：{e}"))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("刷盘失败：{e}"))?;
    tmp.persist(path)
        .map_err(|e| format!("保存文件失败：{e}"))?;
    Ok(())
}

pub(super) fn download_offset(response: &reqwest::Response, offset: u64, total: u64) -> Option<u64> {
    match response.status() {
        StatusCode::OK if response.content_length().is_none_or(|size| size == total) => Some(0),
        StatusCode::PARTIAL_CONTENT if offset < total => {
            let header = response.headers().get(CONTENT_RANGE)?.to_str().ok()?;
            let (range, size) = header.strip_prefix("bytes ")?.split_once('/')?;
            let (start, end) = range.split_once('-')?;
            (start.parse::<u64>().ok()? == offset
                && end.parse::<u64>().ok()? == total - 1
                && size.parse::<u64>().ok()? == total
                && response
                    .content_length()
                    .is_none_or(|length| length == total - offset))
                .then_some(offset)
        }
        _ => None,
    }
}

pub(super) fn build_candidates(raw_url: &str, custom_mirror: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut push = |url: String, label: String| {
        if !out.iter().any(|(existing, _)| existing == &url) {
            out.push((url, label));
        }
    };
    let mirror = custom_mirror.trim().trim_end_matches('/');
    if !mirror.is_empty() && raw_url.starts_with("https://github.com/") {
        push(format!("{mirror}/{raw_url}"), "自定义镜像".into());
    }
    for m in download_transport::public_mirrors(raw_url) {
        let label = url::Url::parse(&m)
            .ok()
            .and_then(|u| u.host_str().map(|h| format!("镜像加速 ({h})")))
            .unwrap_or_else(|| "镜像加速".into());
        push(m, label);
    }
    let direct = if raw_url.starts_with("https://github.com/") {
        "GitHub 直连"
    } else {
        "下载源直连"
    };
    push(raw_url.to_owned(), direct.into());
    out
}

pub(super) fn count_bundled_portraits(assets_root: &Path) -> (usize, u64) {
    let dir = assets_root.join("characters");
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut count = 0usize;
    let mut bytes = 0u64;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let lower = name.to_ascii_lowercase();
        if lower.starts_with("popular-")
            && (lower.ends_with(".png")
                || lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".webp"))
            && let Ok(meta) = entry.metadata()
            && meta.is_file()
        {
            count += 1;
            bytes += meta.len();
        }
    }
    (count, bytes)
}
