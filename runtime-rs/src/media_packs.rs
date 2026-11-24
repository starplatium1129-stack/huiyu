mod archive;
mod http;

use crate::{config::Config, download_transport};
use archive::PackKind;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, RANGE};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub use http::router;

const DEFAULT_MANIFEST_URL: &str = "https://github.com/starplatium1129-stack/huiyu/releases/download/media-packs-latest/media-packs.json";
const DEFAULT_PORTRAITS_ESTIMATE: u64 = 436_500_000;
const DEFAULT_SHOWCASE_ESTIMATE: u64 = 1_650_000_000;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PackSettings {
    #[serde(default)]
    pub mirror_origin: String,
    #[serde(default)]
    pub manifest_url: String,
    #[serde(default)]
    pub onboarding_dismissed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledRecord {
    version: String,
    sha256: String,
    bytes: u64,
    file_count: usize,
    installed_at: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteArchive {
    #[serde(default)]
    file_name: String,
    url: String,
    sha256: String,
    bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemotePack {
    id: String,
    version: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    file_count: usize,
    archive: RemoteArchive,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteIndex {
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    packs: HashMap<String, RemotePack>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskState {
    id: String,
    state: String, // running | cancelling | completed | failed | cancelled
    pack_id: Option<String>,
    queue: Vec<String>,
    completed_packs: Vec<String>,
    phase: String, // fetching-index | downloading | verifying | extracting | switching
    bytes: u64,
    total: u64,
    files_done: usize,
    files_total: usize,
    speed_bps: u64,
    mirror_label: String,
    message: String,
    error: Option<String>,
    started_at: u64,
    finished_at: u64,
}

#[derive(Default)]
struct Inner {
    task: Option<TaskState>,
    cancel: Option<CancellationToken>,
    remote_index: Option<RemoteIndex>,
    remote_fetched_at: Option<Instant>,
    remote_error: Option<String>,
}

pub struct MediaPacksService {
    config: Config,
    root: PathBuf,
    client: reqwest::Client,
    shutdown: CancellationToken,
    workers: TaskTracker,
    inner: Mutex<Inner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn storage_root(config: &Config) -> PathBuf {
    if config.is_packaged()
        && let Some(parent) = config.runtime_root.parent()
    {
        return parent.join("media-packs");
    }
    config.runtime_root.join("media-packs")
}

fn valid_http_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return true;
    }
    url::Url::parse(trimmed)
        .ok()
        .is_some_and(|u| matches!(u.scheme(), "https" | "http") && u.host_str().is_some())
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("序列化失败：{e}"))?;
    fs::write(&tmp, bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    let _ = fs::remove_file(path);
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("保存文件失败：{e}")
    })
}

fn build_candidates(raw_url: &str, custom_mirror: &str) -> Vec<(String, String)> {
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
    push(raw_url.to_owned(), "GitHub 直连".into());
    out
}

fn count_bundled_portraits(assets_root: &Path) -> (usize, u64) {
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

impl MediaPacksService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Arc<Self> {
        let root = storage_root(config);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(10))
            .connect_timeout(Duration::from_secs(20))
            .pool_idle_timeout(Duration::from_secs(60))
            .user_agent("HuiyuStudio-MediaPacks/1")
            .build()
            .expect("media packs http client");
        let cached = read_json_file::<RemoteIndex>(&root.join("index-cache.json"));
        Arc::new(Self {
            config: config.clone(),
            root,
            client,
            shutdown,
            workers: TaskTracker::new(),
            inner: Mutex::new(Inner {
                remote_index: cached,
                ..Default::default()
            }),
        })
    }

    pub async fn close(&self) {
        if let Some(cancel) = self.inner.lock().unwrap().cancel.as_ref() {
            cancel.cancel();
        }
        self.workers.close();
        self.workers.wait().await;
    }

    fn settings(&self) -> PackSettings {
        read_json_file(&self.root.join("settings.json")).unwrap_or_default()
    }

    fn manifest_url(&self, settings: &PackSettings) -> String {
        let custom = settings.manifest_url.trim();
        if custom.is_empty() {
            DEFAULT_MANIFEST_URL.to_owned()
        } else {
            custom.to_owned()
        }
    }

    /// Hot-resolved portraits root (`media-packs/portraits/current/assets`) when downloaded.
    pub(crate) fn portraits_assets_root(&self) -> Option<PathBuf> {
        let dir = self.root.join("portraits").join("current").join("assets");
        dir.is_dir().then_some(dir)
    }

    /// Hot-resolved showcase root (`media-packs/showcase/current`) when downloaded.
    pub(crate) fn showcase_dir(&self) -> Option<PathBuf> {
        let dir = self.root.join("showcase").join("current");
        dir.join("manifest.json").is_file().then_some(dir)
    }

    pub(super) fn update_settings(
        &self,
        mirror_origin: Option<String>,
        manifest_url: Option<String>,
        onboarding_dismissed: Option<bool>,
    ) -> Result<PackSettings, String> {
        let mut current = self.settings();
        if let Some(mirror) = mirror_origin {
            let trimmed = mirror.trim().trim_end_matches('/').to_owned();
            if !valid_http_url(&trimmed) {
                return Err("镜像加速地址必须以 http:// 或 https:// 开头".into());
            }
            current.mirror_origin = trimmed;
        }
        if let Some(url) = manifest_url {
            let trimmed = url.trim().to_owned();
            if !valid_http_url(&trimmed) {
                return Err("资源索引地址必须以 http:// 或 https:// 开头".into());
            }
            current.manifest_url = trimmed;
        }
        if let Some(dismissed) = onboarding_dismissed {
            current.onboarding_dismissed = dismissed;
        }
        write_json_atomic(&self.root.join("settings.json"), &current)?;
        Ok(current)
    }

    async fn fetch_remote_index(&self, force: bool) -> (Option<RemoteIndex>, Option<String>) {
        {
            let inner = self.inner.lock().unwrap();
            if !force
                && let (Some(index), Some(at)) = (&inner.remote_index, inner.remote_fetched_at)
                && at.elapsed() < Duration::from_secs(300)
            {
                return (Some(index.clone()), None);
            }
        }
        let settings = self.settings();
        let manifest_url = self.manifest_url(&settings);
        let candidates = build_candidates(&manifest_url, &settings.mirror_origin);
        let mut last_err = String::from("暂未获取到在线资源索引");
        for (url, label) in candidates {
            let resp = tokio::time::timeout(
                Duration::from_secs(15),
                self.client.get(&url).send(),
            )
            .await;
            match resp {
                Ok(Ok(response)) if response.status().is_success() => {
                    match tokio::time::timeout(Duration::from_secs(15), response.json::<RemoteIndex>()).await {
                        Ok(Ok(index)) if !index.packs.is_empty() => {
                            let _ = write_json_atomic(&self.root.join("index-cache.json"), &index);
                            let mut inner = self.inner.lock().unwrap();
                            inner.remote_index = Some(index.clone());
                            inner.remote_fetched_at = Some(Instant::now());
                            inner.remote_error = None;
                            return (Some(index), None);
                        }
                        Ok(Ok(_)) => last_err = format!("{label}返回的资源索引为空"),
                        Ok(Err(e)) => last_err = format!("{label}资源索引格式无效：{e}"),
                        Err(_) => last_err = format!("读取{label}资源索引超时"),
                    }
                }
                Ok(Ok(response)) => {
                    last_err = format!("{label}返回 HTTP {}", response.status().as_u16());
                }
                Ok(Err(_)) => last_err = format!("无法连接{label}"),
                Err(_) => last_err = format!("连接{label}超时"),
            }
        }
        let mut inner = self.inner.lock().unwrap();
        inner.remote_fetched_at = Some(Instant::now());
        inner.remote_error = Some(last_err.clone());
        (inner.remote_index.clone(), Some(last_err))
    }

    fn partial_bytes(&self, pack_id: &str) -> u64 {
        fs::metadata(self.root.join("downloads").join(format!("{pack_id}.zip.part")))
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .unwrap_or(0)
    }

    pub(super) async fn status(&self, refresh_remote: bool) -> Value {
        if refresh_remote {
            let _ = self.fetch_remote_index(true).await;
        }
        let settings = self.settings();
        let (remote_index, remote_error, task) = {
            let inner = self.inner.lock().unwrap();
            (
                inner.remote_index.clone(),
                inner.remote_error.clone(),
                inner.task.clone(),
            )
        };
        let busy = task
            .as_ref()
            .is_some_and(|t| matches!(t.state.as_str(), "running" | "cancelling"));

        // 1) Portraits pack status
        let (bundled_count, bundled_bytes) = count_bundled_portraits(&self.config.assets_root());
        let downloaded_portraits: Option<InstalledRecord> = if self.portraits_assets_root().is_some() {
            read_json_file(&self.root.join("portraits").join("installed.json"))
        } else {
            None
        };
        let offline_mounted = self.config.runtime_root.join("offline-resource-config.json").is_file();
        let (portraits_installed, portraits_source, portraits_ver, portraits_files, portraits_bytes) =
            if let Some(rec) = &downloaded_portraits {
                (true, "downloaded", Some(rec.version.clone()), rec.file_count, rec.bytes)
            } else if bundled_count > 0 {
                (true, "bundled", Some("bundled".to_owned()), bundled_count, bundled_bytes)
            } else if offline_mounted {
                (true, "offline", Some("offline".to_owned()), 0, 0)
            } else {
                (false, "none", None, 0, 0)
            };

        // 2) Showcase pack status
        let external_showcase = crate::resources::offline::showcase_root(&self.config);
        let downloaded_showcase: Option<InstalledRecord> = if self.showcase_dir().is_some() {
            read_json_file(&self.root.join("showcase").join("installed.json"))
        } else {
            None
        };
        let (showcase_installed, showcase_source, showcase_ver, showcase_files, showcase_bytes) =
            if let Some(rec) = &downloaded_showcase {
                (true, "downloaded", Some(rec.version.clone()), rec.file_count, rec.bytes)
            } else if external_showcase.is_some() {
                let src = if offline_mounted { "offline" } else { "local" };
                (true, src, Some(src.to_owned()), 0, 0)
            } else {
                (false, "none", None, 0, 0)
            };

        let remote_pack = |id: &str, installed_ver: Option<&str>, default_bytes: u64, label: &str, desc: &str| -> Value {
            if let Some(pack) = remote_index.as_ref().and_then(|idx| idx.packs.get(id)) {
                let update_available = installed_ver
                    .is_some_and(|v| !matches!(v, "bundled" | "local" | "offline") && v != pack.version);
                json!({
                    "available": true,
                    "version": pack.version,
                    "label": if pack.label.is_empty() { label } else { &pack.label },
                    "description": if pack.description.is_empty() { desc } else { &pack.description },
                    "bytes": if pack.archive.bytes > 0 { pack.archive.bytes } else { pack.bytes },
                    "fileCount": pack.file_count,
                    "updateAvailable": update_available,
                })
            } else {
                json!({
                    "available": false,
                    "version": null,
                    "label": label,
                    "description": desc,
                    "bytes": default_bytes,
                    "fileCount": 0,
                    "updateAvailable": false,
                })
            }
        };

        let portraits_remote = remote_pack(
            "portraits",
            portraits_ver.as_deref(),
            DEFAULT_PORTRAITS_ESTIMATE,
            "人物高清立绘包",
            "全部热门角色高清原画立绘，用于角色档案原画欣赏、聊天室大立绘与创作项目导入。",
        );
        let showcase_remote = remote_pack(
            "showcase",
            showcase_ver.as_deref(),
            DEFAULT_SHOWCASE_ESTIMATE,
            "场景样张资源库",
            "画册与场景浏览的高清成品样张与缩略图，离线秒看所有推荐场景成图。",
        );

        let should_prompt = !settings.onboarding_dismissed && (!portraits_installed || !showcase_installed);

        json!({
            "ok": true,
            "busy": busy,
            "storageRoot": self.root.to_string_lossy(),
            "remoteReady": remote_index.is_some(),
            "remoteUpdatedAt": remote_index.as_ref().map(|i| i.updated_at.clone()),
            "remoteError": remote_error,
            "settings": {
                "mirrorOrigin": settings.mirror_origin,
                "manifestUrl": settings.manifest_url,
                "defaultManifestUrl": DEFAULT_MANIFEST_URL,
                "onboardingDismissed": settings.onboarding_dismissed,
            },
            "onboarding": {
                "shouldPrompt": should_prompt,
                "dismissed": settings.onboarding_dismissed,
                "missingPortraits": !portraits_installed,
                "missingShowcase": !showcase_installed,
            },
            "packs": [
                {
                    "id": "portraits",
                    "label": portraits_remote["label"],
                    "description": portraits_remote["description"],
                    "installed": portraits_installed,
                    "source": portraits_source,
                    "canUninstall": downloaded_portraits.is_some(),
                    "installedVersion": portraits_ver,
                    "installedFiles": portraits_files,
                    "installedBytes": portraits_bytes,
                    "partialBytes": self.partial_bytes("portraits"),
                    "remote": portraits_remote,
                },
                {
                    "id": "showcase",
                    "label": showcase_remote["label"],
                    "description": showcase_remote["description"],
                    "installed": showcase_installed,
                    "source": showcase_source,
                    "canUninstall": downloaded_showcase.is_some(),
                    "installedVersion": showcase_ver,
                    "installedFiles": showcase_files,
                    "installedBytes": showcase_bytes,
                    "partialBytes": self.partial_bytes("showcase"),
                    "remote": showcase_remote,
                },
            ],
            "task": task,
        })
    }

    pub(super) async fn start_install(self: &Arc<Self>, raw_packs: Vec<String>) -> Result<Value, (&'static str, String)> {
        let mut queue = Vec::new();
        for id in raw_packs {
            if !matches!(id.as_str(), "portraits" | "showcase") {
                return Err(("INVALID_PACK", format!("未知的资源包：{id}")));
            }
            if !queue.contains(&id) {
                queue.push(id);
            }
        }
        if queue.is_empty() {
            return Err(("INVALID_PACK", "请至少选择一个资源包".into()));
        }

        let cancel = self.shutdown.child_token();
        let initial = TaskState {
            id: uuid::Uuid::new_v4().to_string(),
            state: "running".into(),
            pack_id: queue.first().cloned(),
            queue: queue.clone(),
            completed_packs: Vec::new(),
            phase: "fetching-index".into(),
            bytes: 0,
            total: 0,
            files_done: 0,
            files_total: 0,
            speed_bps: 0,
            mirror_label: String::new(),
            message: "正在获取在线资源包索引…".into(),
            error: None,
            started_at: now_ms(),
            finished_at: 0,
        };
        {
            let mut inner = self.inner.lock().unwrap();
            if inner
                .task
                .as_ref()
                .is_some_and(|t| matches!(t.state.as_str(), "running" | "cancelling"))
            {
                return Err(("BUSY", "已有资源包下载任务正在进行，请等待或先取消当前任务".into()));
            }
            inner.task = Some(initial.clone());
            inner.cancel = Some(cancel.clone());
        }

        let service = Arc::clone(self);
        self.workers.spawn(async move {
            service.run_install_queue(queue, cancel).await;
        });
        Ok(serde_json::to_value(initial).unwrap_or(Value::Null))
    }

    pub(super) fn cancel(&self) -> Value {
        let mut inner = self.inner.lock().unwrap();
        if let Some(cancel) = inner.cancel.as_ref() {
            cancel.cancel();
        }
        if let Some(task) = inner.task.as_mut()
            && task.state == "running"
        {
            task.state = "cancelling".into();
            task.message = "正在暂停并保存已下载进度…".into();
        }
        serde_json::to_value(&inner.task).unwrap_or(Value::Null)
    }

    pub(super) async fn uninstall(&self, pack_id: &str) -> Result<(), (&'static str, String)> {
        if !matches!(pack_id, "portraits" | "showcase") {
            return Err(("INVALID_PACK", format!("未知的资源包：{pack_id}")));
        }
        {
            let inner = self.inner.lock().unwrap();
            if inner
                .task
                .as_ref()
                .is_some_and(|t| matches!(t.state.as_str(), "running" | "cancelling"))
            {
                return Err(("BUSY", "请先等待或取消当前下载任务后再卸载资源包".into()));
            }
        }
        let pack_dir = self.root.join(pack_id);
        let part_file = self.root.join("downloads").join(format!("{pack_id}.zip.part"));
        let meta_file = self.root.join("downloads").join(format!("{pack_id}.zip.meta.json"));
        tokio::task::spawn_blocking(move || {
            if pack_dir.exists() {
                fs::remove_dir_all(&pack_dir).map_err(|e| format!("清理资源目录失败：{e}"))?;
            }
            let _ = fs::remove_file(&part_file);
            let _ = fs::remove_file(&meta_file);
            Ok::<(), String>(())
        })
        .await
        .map_err(|_| ("INTERNAL", "清理任务异常中断".to_string()))?
        .map_err(|e| ("IO_ERROR", e))
    }

    fn update_task(&self, f: impl FnOnce(&mut TaskState)) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(task) = inner.task.as_mut() {
            f(task);
        }
    }

    async fn run_install_queue(self: Arc<Self>, queue: Vec<String>, cancel: CancellationToken) {
        let (index, fetch_err) = self.fetch_remote_index(true).await;
        if cancel.is_cancelled() {
            self.finish_task("cancelled", "已暂停下载，已下载部分已保留可续传", None);
            return;
        }
        let Some(index) = index else {
            let reason = fetch_err.unwrap_or_else(|| "无法获取在线资源索引".into());
            self.finish_task(
                "failed",
                "获取在线资源索引失败",
                Some(format!("{reason}。请检查网络或在控制室配置 GitHub 镜像加速，也可直接使用本地离线素材包导入。")),
            );
            return;
        };

        for pack_id in queue {
            if cancel.is_cancelled() {
                self.finish_task("cancelled", "已暂停下载，已下载部分已保留可续传", None);
                return;
            }
            let Some(remote) = index.packs.get(&pack_id).cloned() else {
                self.finish_task(
                    "failed",
                    "在线资源索引中未发布该资源包",
                    Some(format!("当前发布页暂未包含 {pack_id} 资源包，请先在 GitHub Release 发布对应资源包或使用本地离线导入。")),
                );
                return;
            };
            if !valid_http_url(&remote.archive.url)
                || remote.archive.url.is_empty()
                || !is_sha256(&remote.archive.sha256)
            {
                self.finish_task(
                    "failed",
                    "资源包校验信息无效",
                    Some(format!("{pack_id} 资源包的下载地址或 SHA-256 校验值格式无效")),
                );
                return;
            }
            if let Err(error) = self.install_one(&pack_id, &remote, &cancel).await {
                if error == "CANCELLED" || cancel.is_cancelled() {
                    self.finish_task("cancelled", "已暂停下载，已下载部分已保留可续传", None);
                } else {
                    self.finish_task("failed", "资源包安装未完成", Some(error));
                }
                return;
            }
            self.update_task(|t| t.completed_packs.push(pack_id.clone()));
        }

        // Automatically dismiss onboarding once user completed an install run.
        let _ = self.update_settings(None, None, Some(true));
        self.finish_task("completed", "所选资源包已下载并生效，无需重启软件", None);
    }

    fn finish_task(&self, state: &str, message: &str, error: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.cancel = None;
        if let Some(task) = inner.task.as_mut() {
            task.state = state.into();
            task.message = message.into();
            task.error = error;
            task.speed_bps = 0;
            task.finished_at = now_ms();
        }
    }

    async fn install_one(
        self: &Arc<Self>,
        pack_id: &str,
        remote: &RemotePack,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let downloads_dir = self.root.join("downloads");
        fs::create_dir_all(&downloads_dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
        let part_path = downloads_dir.join(format!("{pack_id}.zip.part"));
        let meta_path = downloads_dir.join(format!("{pack_id}.zip.meta.json"));

        #[derive(Serialize, Deserialize)]
        struct PartMeta {
            sha256: String,
            bytes: u64,
        }
        let saved_meta: Option<PartMeta> = read_json_file(&meta_path);
        let mut offset = fs::metadata(&part_path)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .unwrap_or(0);
        if offset > 0
            && (saved_meta
                .as_ref()
                .is_none_or(|m| !m.sha256.eq_ignore_ascii_case(&remote.archive.sha256) || m.bytes != remote.archive.bytes)
                || offset > remote.archive.bytes)
        {
            let _ = fs::remove_file(&part_path);
            offset = 0;
        }
        write_json_atomic(
            &meta_path,
            &PartMeta {
                sha256: remote.archive.sha256.clone(),
                bytes: remote.archive.bytes,
            },
        )?;

        let label = if pack_id == "portraits" { "人物高清立绘包" } else { "场景样张资源库" };
        self.update_task(|t| {
            t.pack_id = Some(pack_id.to_owned());
            t.phase = "downloading".into();
            t.bytes = offset;
            t.total = remote.archive.bytes;
            t.files_done = 0;
            t.files_total = remote.file_count;
            t.speed_bps = 0;
            t.message = format!("正在连接下载源：{label}…");
        });

        // Step 1: Download with resumable HTTP Range + mirror fallback.
        if offset < remote.archive.bytes || remote.archive.bytes == 0 {
            let settings = self.settings();
            let candidates = build_candidates(&remote.archive.url, &settings.mirror_origin);
            let mut downloaded = false;
            let mut last_error = String::from("所有下载源均连接失败");

            for (candidate_url, mirror_label) in candidates {
                if cancel.is_cancelled() {
                    return Err("CANCELLED".into());
                }
                self.update_task(|t| {
                    t.mirror_label = mirror_label.clone();
                    t.message = format!("正在通过{mirror_label}下载{label}…");
                });
                let mut headers = HeaderMap::new();
                if offset > 0
                    && let Ok(val) = format!("bytes={offset}-").parse()
                {
                    headers.insert(RANGE, val);
                }
                let response = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("CANCELLED".into()),
                    res = tokio::time::timeout(Duration::from_secs(25), self.client.get(&candidate_url).headers(headers).send()) => {
                        match res {
                            Ok(Ok(r)) => r,
                            Ok(Err(e)) => { last_error = format!("{mirror_label}连接失败：{e}"); continue; }
                            Err(_) => { last_error = format!("{mirror_label}连接超时"); continue; }
                        }
                    }
                };
                let status = response.status();
                if !status.is_success() {
                    if status.as_u16() == 416 && offset > 0 {
                        let _ = fs::remove_file(&part_path);
                        offset = 0;
                    }
                    last_error = format!("{mirror_label}返回 HTTP {}", status.as_u16());
                    continue;
                }
                let append = status.as_u16() == 206 && offset > 0;
                if !append {
                    offset = 0;
                }
                let total = if remote.archive.bytes > 0 {
                    remote.archive.bytes
                } else {
                    response.content_length().map(|l| l + offset).unwrap_or(0)
                };
                let std_file = fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .append(append)
                    .truncate(!append)
                    .open(&part_path)
                    .map_err(|e| format!("打开下载缓存文件失败：{e}"))?;
                let mut writer = BufWriter::with_capacity(256 * 1024, tokio::fs::File::from_std(std_file));
                let mut stream = response.bytes_stream();
                let mut received = offset;
                let mut window_bytes = 0u64;
                let mut last_tick = Instant::now();
                let mut stream_err = None;

                loop {
                    let next_chunk = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            let _ = writer.flush().await;
                            return Err("CANCELLED".into());
                        }
                        item = tokio::time::timeout(Duration::from_secs(30), stream.next()) => item,
                    };
                    match next_chunk {
                        Ok(Some(Ok(chunk))) => {
                            if let Err(e) = writer.write_all(&chunk).await {
                                stream_err = Some(format!("写入磁盘失败：{e}"));
                                break;
                            }
                            let n = chunk.len() as u64;
                            received += n;
                            window_bytes += n;
                            let elapsed = last_tick.elapsed();
                            if elapsed >= Duration::from_millis(250) {
                                let bps = ((window_bytes as f64) / elapsed.as_secs_f64()).round() as u64;
                                self.update_task(|t| {
                                    t.bytes = received;
                                    t.total = total;
                                    t.speed_bps = bps;
                                });
                                window_bytes = 0;
                                last_tick = Instant::now();
                            }
                        }
                        Ok(Some(Err(e))) => {
                            stream_err = Some(format!("{mirror_label}传输中断：{e}"));
                            break;
                        }
                        Ok(None) => break,
                        Err(_) => {
                            stream_err = Some(format!("{mirror_label}读取超时"));
                            break;
                        }
                    }
                }
                writer.flush().await.map_err(|e| format!("刷盘失败：{e}"))?;
                drop(writer);
                offset = received;
                self.update_task(|t| {
                    t.bytes = received;
                    t.total = total;
                });

                if let Some(err) = stream_err {
                    last_error = err;
                    continue;
                }
                if remote.archive.bytes > 0 && received != remote.archive.bytes {
                    last_error = format!("{mirror_label}下载不完整（{received}/{} 字节）", remote.archive.bytes);
                    continue;
                }
                downloaded = true;
                break;
            }
            if !downloaded {
                return Err(format!("下载{label}失败：{last_error}"));
            }
        }

        // Step 2: Verify SHA-256 of completed archive.
        self.update_task(|t| {
            t.phase = "verifying".into();
            t.speed_bps = 0;
            t.message = format!("正在校验{label}完整性（SHA-256）…");
        });
        let verify_path = part_path.clone();
        let verify_cancel = cancel.clone();
        let expected_sha = remote.archive.sha256.clone();
        let actual_sha = tokio::task::spawn_blocking(move || -> Result<String, String> {
            use std::io::Read;
            let mut file = fs::File::open(&verify_path).map_err(|e| format!("读取下载包失败：{e}"))?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 512 * 1024];
            loop {
                if verify_cancel.is_cancelled() {
                    return Err("CANCELLED".into());
                }
                let n = file.read(&mut buf).map_err(|e| format!("校验读取失败：{e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(hex::encode(hasher.finalize()))
        })
        .await
        .map_err(|_| "校验任务异常中断".to_string())??;
        if !actual_sha.eq_ignore_ascii_case(&expected_sha) {
            let _ = fs::remove_file(&part_path);
            let _ = fs::remove_file(&meta_path);
            return Err(format!("{label}完整性校验不通过，已清理损坏缓存，请重新下载"));
        }

        // Step 3: Extract into isolated staging dir and atomically swap into current.
        let pack_root = self.root.join(pack_id);
        let staging_dir = pack_root.join(format!("staging-{}", uuid::Uuid::new_v4()));
        let current_dir = pack_root.join("current");
        let previous_dir = pack_root.join(format!("previous-{}", uuid::Uuid::new_v4()));
        let kind = if pack_id == "portraits" {
            PackKind::Portraits
        } else {
            PackKind::Showcase
        };

        self.update_task(|t| {
            t.phase = "extracting".into();
            t.files_done = 0;
            t.files_total = remote.file_count;
            t.message = format!("正在解压安装{label}…");
        });
        let extract_archive = part_path.clone();
        let extract_dest = staging_dir.clone();
        let extract_cancel = cancel.clone();
        let progress_service = Arc::clone(self);
        let (file_count, extracted_bytes) = tokio::task::spawn_blocking(move || {
            archive::extract_pack(&extract_archive, &extract_dest, kind, &extract_cancel, |done, total| {
                progress_service.update_task(|t| {
                    t.files_done = done;
                    t.files_total = total;
                });
            })
        })
        .await
        .map_err(|_| "解压任务异常中断".to_string())?
        .inspect_err(|_| {
            let _ = fs::remove_dir_all(&staging_dir);
        })?;

        self.update_task(|t| {
            t.phase = "switching".into();
            t.message = format!("正在启用{label}…");
        });
        let swap_res = (|| -> Result<(), String> {
            let had_current = current_dir.exists();
            if had_current {
                fs::rename(&current_dir, &previous_dir).map_err(|e| format!("切换旧资源目录失败：{e}"))?;
            }
            if let Err(e) = fs::rename(&staging_dir, &current_dir) {
                if had_current {
                    let _ = fs::rename(&previous_dir, &current_dir);
                }
                return Err(format!("启用新资源目录失败：{e}"));
            }
            write_json_atomic(
                &pack_root.join("installed.json"),
                &InstalledRecord {
                    version: remote.version.clone(),
                    sha256: remote.archive.sha256.clone(),
                    bytes: extracted_bytes,
                    file_count,
                    installed_at: now_ms(),
                },
            )?;
            if had_current {
                let _ = fs::remove_dir_all(&previous_dir);
            }
            Ok(())
        })();
        if let Err(e) = swap_res {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(e);
        }
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&meta_path);
        Ok(())
    }
}
