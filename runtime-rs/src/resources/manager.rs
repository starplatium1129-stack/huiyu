mod tasks;
use super::{
    Error, Result, Value,
    config::{self, Configuration},
    fs, json,
    resolve::{self, Snapshot},
};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
#[derive(Default)]
struct Data {
    loaded: bool,
    config: Option<Arc<Configuration>>,
    snapshot: Option<Arc<Snapshot>>,
    issue: Option<Value>,
    task: Option<Value>,
    cancel: Option<CancellationToken>,
    previous: bool,
    last_installed: Option<Value>,
}
pub struct Service {
    gateway: crate::config::Config,
    configuration: Option<PathBuf>,
    management: bool,
    client: reqwest::Client,
    shutdown: CancellationToken,
    pub(super) read_cancel: CancellationToken,
    closed: AtomicBool,
    active: AtomicBool,
    workers: TaskTracker,
    data: Mutex<Data>,
}
impl Service {
    pub fn new(config: &crate::config::Config, shutdown: CancellationToken) -> Result<Self> {
        Self::configured(
            config,
            std::env::var_os("AICS_RESOURCE_CONFIG")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    let path = config.runtime_root.join("offline-resource-config.json");
                    path.exists().then_some(path)
                }),
            std::env::var("AICS_RESOURCE_MANAGEMENT").as_deref() == Ok("trusted"),
            shutdown,
        )
    }
    pub(super) fn configured(
        config: &crate::config::Config,
        configuration: Option<PathBuf>,
        management: bool,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(std::time::Duration::from_secs(30))
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|_| Error::new("RESOURCE_FAILED", "Cannot initialize resource HTTP client"))?;
        Ok(Self {
            gateway: config.clone(),
            configuration,
            management,
            client,
            read_cancel: shutdown.child_token(),
            shutdown,
            closed: AtomicBool::new(false),
            active: AtomicBool::new(false),
            workers: TaskTracker::new(),
            data: Mutex::new(Data::default()),
        })
    }
    pub fn queue_status(&self) -> Value {
        json!({"active":usize::from(self.active.load(Ordering::Acquire)),"queued":0,"max":1})
    }
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        // Stop read/hash loops before waiting for a snapshot refresh to release
        // the state lock, without revoking management rollback authorization.
        self.read_cancel.cancel();
        if let Some(cancel) = &self.data.lock().unwrap().cancel {
            cancel.cancel();
        }
        self.workers.close();
        self.workers.wait().await;
    }
    fn refresh(&self, data: &mut Data) {
        if self.active.load(Ordering::Acquire) {
            return;
        }
        data.loaded = true;
        data.config = None;
        data.snapshot = None;
        data.task = None;
        data.previous = false;
        data.issue = None;
        let Some(file) = &self.configuration else {
            return;
        };
        let result = (|| {
            let configuration = Arc::new(config::load(&self.gateway, file, self.shutdown.clone())?);
            data.config = Some(configuration.clone());
            data.task = tasks::saved(&configuration.ctx)?;
            let snapshot = resolve::snapshot(&configuration.ctx, &self.read_cancel)?.map(Arc::new);
            if let Some(snapshot) = &snapshot {
                data.last_installed = Some(
                    json!({"identity":snapshot.identity,"releaseId":snapshot.release_id,"files":snapshot.verified_files}),
                );
                data.previous = snapshot.previous;
            }
            data.snapshot = snapshot;
            Ok(())
        })();
        if let Err(error) = result {
            data.issue = Some(super::public(&error));
        }
    }
    pub(super) fn invalidate(
        &self,
        configuration: &Arc<Configuration>,
        snapshot: &Arc<Snapshot>,
        error: Error,
    ) {
        let mut data = self.data.lock().unwrap();
        if self.active.load(Ordering::Acquire)
            || self.closed.load(Ordering::Acquire)
            || !data
                .config
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, configuration))
            || !data
                .snapshot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, snapshot))
        {
            return;
        }
        data.snapshot = None;
        data.issue = Some(super::public(&error));
    }
    pub(super) fn mount(&self, relative: &str) -> Option<(Arc<Configuration>, Arc<Snapshot>)> {
        if self.active.load(Ordering::Acquire) || self.closed.load(Ordering::Acquire) {
            return None;
        }
        let (configuration, snapshot) = {
            let mut data = self.data.lock().unwrap();
            if self.active.load(Ordering::Acquire) || self.closed.load(Ordering::Acquire) {
                return None;
            }
            if !data.loaded {
                self.refresh(&mut data);
            }
            let snapshot = data.snapshot.as_ref()?;
            // Bundled-only assets need no mount authorization: they cannot
            // publish bytes from this snapshot, even if it has been revoked.
            if !snapshot.entries.contains_key(relative) {
                return None;
            }
            (data.config.clone()?, snapshot.clone())
        };
        // Disk authorization and pointer checks must not serialize unrelated
        // requests or prevent cancellation/close from acquiring the state lock.
        if let Err(error) = resolve::mount(&configuration.ctx, &snapshot) {
            self.invalidate(&configuration, &snapshot, error);
            return None;
        }
        let data = self.data.lock().unwrap();
        if self.active.load(Ordering::Acquire)
            || self.closed.load(Ordering::Acquire)
            || !data
                .config
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &configuration))
            || !data
                .snapshot
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &snapshot))
        {
            return None;
        }
        Some((configuration, snapshot))
    }
    pub(super) fn status(&self, refresh: bool) -> Value {
        let mut data = self.data.lock().unwrap();
        let active = self.active.load(Ordering::Acquire);
        if !active
            && (!data.loaded
                || refresh
                || data
                    .config
                    .as_ref()
                    .is_some_and(|configuration| !configuration.ctx.unchanged()))
        {
            self.refresh(&mut data);
        }
        if !active
            && let (Some(configuration), Some(snapshot)) = (&data.config, &data.snapshot)
            && let Err(error) = resolve::mount(&configuration.ctx, snapshot)
        {
            data.snapshot = None;
            data.issue = Some(super::public(&error));
        }
        let recovery = data.issue.as_ref().is_some_and(|issue| {
            matches!(
                issue["code"].as_str(),
                Some("PENDING_TRANSACTION" | "BUSY" | "STATE_CONFLICT")
            )
        }) || data.task.as_ref().is_some_and(|task| {
            matches!(
                task["state"].as_str(),
                Some("interrupted" | "cancelled" | "failed")
            )
        });
        let releases = data
            .config
            .as_ref()
            .map(|configuration| {
                configuration
                    .releases
                    .iter()
                    .map(|release| {
                        let mut value = release.clone();
                        let downloaded = (|| {
                            if release["source"] != "http" {
                                return Ok::<_, Error>(false);
                            }
                            let approved = super::policy::release(
                                &configuration.ctx,
                                release["id"].as_str().unwrap(),
                            )?;
                            let file = fs::child(
                                &configuration.ctx.store,
                                &format!(
                                    "downloads/{}/complete.json",
                                    approved["packageIdentity"].as_str().unwrap()
                                ),
                            )?;
                            Ok(fs::json(&file, true, false)?.is_some_and(|value| {
                                value["packageIdentity"] == approved["packageIdentity"]
                            }))
                        })()
                        .unwrap_or(false);
                        value["downloaded"] = downloaded.into();
                        value
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let current=data.snapshot.as_ref().map(|snapshot|json!({"identity":snapshot.identity,"releaseId":snapshot.release_id,"files":snapshot.verified_files})).or_else(||if active{data.last_installed.clone()}else{None});
        json!({"ok":true,"configured":data.config.is_some(),"managementEnabled":data.config.is_some()&&self.management&&!self.closed.load(Ordering::Acquire),"busy":active,"mounted":data.snapshot.is_some()&&!active,"current":current,"canRollback":data.previous,"recoveryRequired":recovery,"issue":data.issue,"releases":releases,"task":data.task})
    }
    pub(super) fn cancel(&self, id: &str) -> Result<Value> {
        let mut data = self.data.lock().unwrap();
        if !self.management
            || data
                .config
                .as_ref()
                .is_none_or(|config| !config.ctx.unchanged())
        {
            return Err(Error::new(
                "ACCESS_DENIED",
                "Local configuration authorization invalid",
            ));
        }
        if data.task.as_ref().is_none_or(|task| task["id"] != id) {
            return Err(Error::new("TASK_NOT_FOUND", "Task not found"));
        }
        if let Some(cancel) = data.cancel.clone() {
            data.task.as_mut().unwrap()["state"] = "cancelling".into();
            cancel.cancel();
        }
        Ok(data.task.clone().unwrap())
    }
    pub(super) fn start(
        self: &Arc<Self>,
        action: &str,
        release: Option<&str>,
        admission: crate::host::OwnedWriteGuard,
    ) -> Result<Value> {
        tasks::start(self, action, release, admission)
    }
}
