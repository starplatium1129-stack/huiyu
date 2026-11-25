mod archive;
mod http;
mod install;
mod storage;

use crate::config::Config;
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use storage::{
    DEFAULT_MANIFEST_URL, DEFAULT_PORTRAITS_ESTIMATE, DEFAULT_SHOWCASE_ESTIMATE, Inner,
    InstalledRecord, RemoteIndex, TaskState, build_candidates, count_bundled_portraits, now_ms,
    read_json_file, storage_root, valid_http_url, write_json_atomic,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub use http::router;
pub(super) use storage::PackSettings;

pub struct MediaPacksService {
    config: Config,
    root: PathBuf,
    client: reqwest::Client,
    shutdown: CancellationToken,
    workers: TaskTracker,
    mutation: Arc<tokio::sync::Mutex<()>>,
    settings_write: Mutex<()>,
    inner: Mutex<Inner>,
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
            mutation: Arc::new(tokio::sync::Mutex::new(())),
            settings_write: Mutex::new(()),
            inner: Mutex::new(Inner {
                remote_index: cached,
                ..Default::default()
            }),
        })
    }

    pub async fn close(&self) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.closed = true;
            if let Some(cancel) = &inner.cancel {
                cancel.cancel();
            }
            self.workers.close();
        }
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
        let _guard = self.settings_write.lock().unwrap();
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
            if external_showcase.is_some() {
                let has_local_override = read_json_file::<Value>(&self.config.runtime_root.join("config.json"))
                    .is_some_and(|config| config["localShowcaseDir"].as_str().is_some_and(|value| !value.trim().is_empty()));
                let src = if offline_mounted && !has_local_override { "offline" } else { "local" };
                let (files, bytes) = downloaded_showcase.as_ref().map_or((0, 0), |rec| (rec.file_count, rec.bytes));
                (true, src, Some(src.to_owned()), files, bytes)
            } else if let Some(rec) = &downloaded_showcase {
                (true, "downloaded", Some(rec.version.clone()), rec.file_count, rec.bytes)
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
            downloaded_showcase.as_ref().map(|rec| rec.version.as_str()).or(showcase_ver.as_deref()),
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

        let mutation = self.mutation.clone().try_lock_owned()
            .map_err(|_| ("BUSY", "请等待当前资源包操作完成".to_owned()))?;
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
            if inner.closed || cancel.is_cancelled() {
                return Err(("CLOSED", "资源包服务正在关闭".into()));
            }
            if inner
                .task
                .as_ref()
                .is_some_and(|t| matches!(t.state.as_str(), "running" | "cancelling"))
            {
                return Err(("BUSY", "已有资源包下载任务正在进行，请等待或先取消当前任务".into()));
            }
            inner.task = Some(initial.clone());
            inner.cancel = Some(cancel.clone());
            let service = Arc::clone(self);
            self.workers.spawn(async move {
                let _mutation = mutation;
                service.run_install_queue(queue, cancel).await;
            });
        }
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
        let mutation = self.mutation.clone().try_lock_owned()
            .map_err(|_| ("BUSY", "请先等待或取消当前下载任务后再卸载资源包".to_owned()))?;
        {
            let inner = self.inner.lock().unwrap();
            if inner.closed || self.shutdown.is_cancelled() {
                return Err(("CLOSED", "资源包服务正在关闭".into()));
            }
        }
        let pack_dir = self.root.join(pack_id);
        let part_file = self.root.join("downloads").join(format!("{pack_id}.zip.part"));
        let meta_file = self.root.join("downloads").join(format!("{pack_id}.zip.meta.json"));
        tokio::task::spawn_blocking(move || {
            let _mutation = mutation;
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
}
