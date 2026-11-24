mod actions;
mod hooks;
mod recovery;
mod run;
mod saved_output;
use super::*;
pub(crate) use recovery::BatchRecovery;
use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::Mutex;
pub struct BatchPrepared {
    pub input: Value,
    first: Prepared,
    originals: inputs::Captured,
}
impl BatchPrepared {
    pub(crate) fn provider(&self) -> &str {
        self.first.provider()
    }
}
pub(super) struct Batch {
    pub id: String,
    pub owner: String,
    pub input: Value,
    pub created: i64,
    idle_since: std::sync::Mutex<Instant>,
    pub hooks: Option<Arc<dyn ExecutionHooks>>,
    state: Mutex<State>,
    serial: Mutex<()>,
    checkpoint_serial: Mutex<()>,
    concat_serial: Mutex<()>,
    recovered_outputs: Arc<saved_output::Proofs>,
}
pub(super) struct State {
    status: String,
    shots: Vec<Shot>,
    concat: Option<Output>,
    concat_stage: &'static str,
    unknown: bool,
    error_code: Option<String>,
    cancel: CancellationToken,
    cancel_generation: u64,
}
struct Shot {
    input: Value,
    native_runtime: Option<Value>,
    status: String,
    attempts: u64,
    upstream: Option<String>,
    intent: Option<i64>,
    gateway: Option<String>,
    tail: Option<String>,
    result: Option<Output>,
    code: Option<String>,
    error: Option<String>,
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn output(value: &Option<Output>) -> Value {
    match value {
        Some(Output::File { path, mime, .. }) => json!({"path":path,"mime":mime}),
        _ => Value::Null,
    }
}
impl Batch {
    fn touch(&self) {
        *self.idle_since.lock().unwrap() = Instant::now();
    }
    async fn checkpoint(&self) -> Value {
        let s = self.state.lock().await;
        let shots = s.shots.iter().enumerate().map(|(i, s)| {
            let mut value = json!({"index":i+1,"input":s.input,"status":s.status,"attempts":s.attempts,"upstreamId":s.upstream,"submissionIntentAt":s.intent,"gatewayJobId":s.gateway,"tailFrame":s.tail,"result":null,"errorCode":s.code});
            value["result"] = output(&s.result);
            if let Some(observed) = &s.native_runtime { value["nativeRuntime"] = observed.clone(); }
            value
        }).collect();
        let mut value = json!({"gatewayJobId":self.id,"status":s.status,"linkLastFrame":self.input["linkLastFrame"],"modelId":self.input["modelId"],"aspectRatio":self.input["aspectRatio"],"quality":self.input["quality"],"concatStage":s.concat_stage,"concat":null,"shots":null});
        value["concat"] = output(&s.concat);
        value["shots"] = Value::Array(shots);
        if self.input["inferenceEngine"] == "native" {
            for key in ["inferenceEngine", "h3Decoder", "videoAttention"] {
                value[key] = self.input[key].clone();
            }
        }
        value
    }
    async fn save(&self) -> Result<()> {
        self.touch();
        let _gate = self.checkpoint_serial.lock().await;
        if let Some(h) = &self.hooks {
            h.checkpoint(self.checkpoint().await).await?;
        }
        Ok(())
    }
    async fn public(&self, service: &Service) -> Value {
        // A paused legacy runner can have a failed display row while its job
        // outcome is still unknown. Observe those original identities, never
        // infer settlement from the row label or from unsubmitted pending rows.
        let gate = self.serial.try_lock().ok();
        let stopped = !matches!(
            self.state.lock().await.status.as_str(),
            "running" | "cancelling"
        );
        let observed = if stopped && gate.is_some() {
            Some(service.reconcile_live(self).await.unwrap_or(false))
        } else {
            None
        };
        let s = self.state.lock().await;
        let stopped = !matches!(s.status.as_str(), "running" | "cancelling");
        let settled = stopped && observed == Some(true);
        let unknown = if stopped { !settled } else { s.unknown };
        let shots = s.shots.iter().enumerate().map(|(i, s)| {
            let mut row = json!({"index":i+1,"status":s.status,"prompt":s.input["originalPrompt"],"dialogue":s.input["dialogue"],"shotSize":s.input["shotSize"],"camera":s.input["camera"],"motion":s.input["motion"],"duration":s.input["duration"],"seed":s.input["seed"],"attempts":s.attempts,"error":s.error,"code":s.code,"resultAvailable":s.result.is_some(),"resultUrl":s.result.as_ref().and(s.gateway.as_ref()).map(|id|format!("/api/video/jobs/{id}/result"))});
            if let Some(observed) = &s.native_runtime { row["nativeRuntime"] = observed.clone(); }
            row
        }).collect();
        let mut value = json!({"id":self.id,"status":s.status,"upstreamSettled":settled,"unknown":unknown,"modelId":self.input["modelId"],"aspectRatio":self.input["aspectRatio"],"quality":self.input["quality"],"steps":self.input["steps"],"linkLastFrame":self.input["linkLastFrame"],"progress":{"total":s.shots.len(),"succeeded":s.shots.iter().filter(|s|s.status=="succeeded").count(),"failed":s.shots.iter().filter(|s|s.status=="failed").count()},"createdAt":self.created,"shots":null,"concatAvailable":s.concat.is_some(),"concatUrl":s.concat.as_ref().map(|_|format!("/api/video/batches/{}/result",self.id))});
        if self.input["inferenceEngine"] == "native" {
            value["h3Decoder"] = self.input["h3Decoder"].clone();
            value["videoAttention"] = self.input["videoAttention"].clone();
        }
        value["shots"] = Value::Array(shots);
        value
    }
}
impl Service {
    pub(super) async fn prepare_batch_normalized(
        &self,
        input: Value,
        cancel: CancellationToken,
    ) -> Result<BatchPrepared> {
        self.prepare_batch_validated(input, true, None, cancel)
            .await
    }
    pub async fn prepare_batch(
        &self,
        raw: Value,
        local: bool,
        cancel: CancellationToken,
    ) -> Result<BatchPrepared> {
        self.prepare_batch_owned(raw, local, None, cancel).await
    }
    pub(super) async fn prepare_batch_owned(
        &self,
        raw: Value,
        local: bool,
        owner: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<BatchPrepared> {
        let pack = if self.backend.native_enabled() {
            let pack = native::packed_h3(&self.backend.native_settings()?, &raw["modelId"]).await?;
            if pack.is_none() {
                if raw["modelId"] == "minimax-h3" && (raw["steps"] == 2 || raw["h3Decoder"] == "dwd") {
                    return Err(error(400, "UNSUPPORTED_ACCELERATION", "本机尚未验证 H3 INT8 主干和 pi-H3 DWD 两步权重，请先导入。"));
                }
                return Err(error(400, "NATIVE_VIDEO_BATCH_UNSUPPORTED", "原生分镜批量需要已导入的 MiniMax H3 本地量化主干。"));
            }
            pack
        } else { None };
        let input = batch_input::validate_batch(&raw, pack.as_ref())?;
        drop(raw);
        self.prepare_batch_validated(input, local, owner, cancel)
            .await
    }
    async fn prepare_batch_validated(
        &self,
        mut input: Value,
        local: bool,
        owner: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<BatchPrepared> {
        let native = input["inferenceEngine"] == "native";
        if native != self.backend.native_enabled() {
            return Err(error(409, "TASK_RESUME_UNSAFE", "分镜批次保存的推理引擎与当前设置不一致"));
        }
        let id = input["modelId"].clone();
        let linked = input["linkLastFrame"] == true;
        let shots = input["shots"]
            .as_array_mut()
            .filter(|a| !a.is_empty() && a.len() <= 30)
            .ok_or_else(|| error(409, "TASK_RESUME_UNSAFE", "已保存的分镜参数无效"))?;
        let mut combined = json!({});
        combined["references"] = json!(shots.iter().flat_map(|s| inputs::names(&s["input"])).collect::<Vec<_>>());
        if native {
            let settings = self.backend.native_settings()?;
            let pack = native::packed_h3(&settings, &id).await?
                .ok_or_else(|| error(400, "UNSUPPORTED_ACCELERATION", "原生分镜批量需要已验证的 H3 本地权重。"))?;
            for shot in shots.iter_mut() {
                if shot["input"]["modelId"] != id {
                    return Err(error(409, "TASK_RESUME_UNSAFE", "分镜镜头的模型与批次不一致"));
                }
                shot["input"] = native::normalize(shot["input"].take(), Some(&pack))?;
            }
            let permit = self.backend.reserve_native(&cancel)?;
            let originals = inputs::capture(&self.config, &combined, local, owner, &cancel).await?;
            let shot = &shots[0]["input"];
            let first = self.prepare_native_captured(shot.clone(), &settings, permit, originals.subset(shot), &cancel).await?;
            return Ok(BatchPrepared { input, first, originals });
        }
        if shots.iter().any(|s| s["input"]["inferenceEngine"] == "native") {
            return Err(error(409, "TASK_RESUME_UNSAFE", "分镜镜头的推理引擎与批次不一致"));
        }
        if id == "wan2.2-ti2v-5b" && linked && shots.len() > 1
        {
            return Err(error(
                400,
                "MODEL_INPUT_MODE",
                "Wan 当前工作流仅支持文本分镜，请关闭尾帧衔接",
            ));
        }
        let t8 = self.t8(&cancel).await;
        for shot in shots.iter() {
            // Preflight every shot without cloning recipes or compiling graphs
            // that execution will rebuild with the current linked frame.
            resources::requirements(&self.config, &shot["input"], t8)?;
        }
        // Reserve the existing video slot before copying any potentially large
        // set of references; the first shot shares these immutable snapshots.
        let backend = self
            .backend
            .prepare_comfy(
                resources::plan(&self.config, shots[0]["input"].clone(), t8, true)?,
                cancel.clone(),
            )
            .await?;
        let originals = inputs::capture(&self.config, &combined, local, owner, &cancel).await?;
        let first = Prepared {
            originals: originals.subset(&backend.input),
            backend,
        };
        Ok(BatchPrepared {
            input,
            first,
            originals,
        })
    }
    pub async fn submit_batch(
        self: Arc<Self>,
        prepared: BatchPrepared,
        owner: String,
        hooks: Option<Arc<dyn ExecutionHooks>>,
    ) -> Result<Value> {
        self.submit_batch_accepting(prepared, owner, hooks, None)
            .await
    }
    pub(super) async fn submit_batch_accepting(
        self: Arc<Self>,
        mut prepared: BatchPrepared,
        owner: String,
        hooks: Option<Arc<dyn ExecutionHooks>>,
        acceptance: Option<&dyn ExecutionHooks>,
    ) -> Result<Value> {
        inputs::protect_restore(
            &self.config,
            &prepared.originals,
            hooks.as_deref(),
            &self.shutdown,
        )
        .await?;
        // Recipes belong to mutable shot state, not the batch-level settings.
        let mut rows = prepared.input["shots"].take();
        let shots = rows
            .as_array_mut()
            .unwrap()
            .drain(..)
            .map(|mut s| Shot {
                input: s.get_mut("input").map(Value::take).unwrap_or_default(),
                native_runtime: None,
                status: "pending".into(),
                attempts: 0,
                upstream: None,
                intent: None,
                gateway: None,
                tail: None,
                result: None,
                code: None,
                error: None,
            })
            .collect();
        drop(rows);
        let batch = Arc::new(Batch {
            id: uuid::Uuid::new_v4().simple().to_string(),
            owner,
            input: prepared.input,
            created: now(),
            idle_since: std::sync::Mutex::new(Instant::now()),
            hooks,
            state: Mutex::new(State {
                status: "running".into(),
                shots,
                concat: None,
                concat_stage: "none",
                unknown: false,
                error_code: None,
                cancel: self.shutdown.child_token(),
                cancel_generation: 0,
            }),
            serial: Mutex::new(()),
            checkpoint_serial: Mutex::new(()),
            concat_serial: Mutex::new(()),
            recovered_outputs: Arc::new(saved_output::Proofs::default()),
        });
        batch.save().await?;
        self.save_batch_identity(&batch).await?;
        self.batches
            .lock()
            .await
            .insert(batch.id.clone(), batch.clone());
        if let Some(acceptance) = acceptance
            && let Err(error) = acceptance
                .checkpoint(json!({"gatewayJobId":batch.id}))
                .await
        {
            self.batches.lock().await.remove(&batch.id);
            return Err(error);
        }
        self.kick(batch.clone(), Some(prepared.first));
        Ok(batch.public(&self).await)
    }
    fn kick(self: &Arc<Self>, batch: Arc<Batch>, first: Option<Prepared>) {
        let service = self.clone();
        self.tasks.spawn(async move {
            run::execute(service, batch, first).await;
        });
    }
    async fn save_batch_identity(&self, batch: &Batch) -> Result<()> {
        let directory = self.config.runtime_root.join("jobs/video-batch");
        tokio::fs::create_dir_all(&directory).await?;
        let pending = directory.join(format!("{}.tmp", batch.id));
        tokio::fs::write(&pending,serde_json::to_vec(&json!({"id":batch.id,"owner":batch.owner,"createdAt":batch.created,"status":"running"}))?).await?;
        tokio::fs::rename(pending, directory.join(format!("{}.json", batch.id))).await?;
        Ok(())
    }
    async fn batch(&self, id: &str, owner: &str) -> Result<Arc<Batch>> {
        {
            let batches = self.batches.lock().await;
            if let Some(batch) = batches.get(id).filter(|b| b.owner == owner) {
                batch.touch();
                return Ok(batch.clone());
            }
        }
        if id.len() <= 80
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
            && let Ok(bytes) = tokio::fs::read(
                self.config
                    .runtime_root
                    .join("jobs/video-batch")
                    .join(format!("{id}.json")),
            )
            .await
            && let Ok(v) = serde_json::from_slice::<Value>(&bytes)
            && v["owner"] == owner
            && v["id"] == id
        {
            return Err(error(
                410,
                "BATCH_LOST",
                "网关重启导致该分镜任务中断，请通过持久任务核对",
            ));
        }
        Err(error(404, "BATCH_NOT_FOUND", "分镜任务不存在"))
    }
    pub async fn get_batch(&self, id: &str, owner: &str) -> Result<Value> {
        Ok(self.batch(id, owner).await?.public(self).await)
    }
    pub async fn query_batch(&self, id: &str, owner: &str) -> Result<Observation> {
        let batch = self.batch(id, owner).await?;
        let s = batch.state.lock().await;
        let done = s.status == "done";
        let cancelled = s.status == "cancelled" && !s.unknown;
        Ok(Observation {
            status: if done {
                "succeeded"
            } else if cancelled {
                "cancelled"
            } else {
                "running"
            }
            .into(),
            settled: done || cancelled,
            unknown: s.unknown || s.status == "paused",
            error_code: s.error_code.clone(),
            metadata: json!({"gatewayJobId":id,"family":"video-batch"}),
            outputs: Vec::new(),
        })
    }
    pub async fn batch_result(&self, id: &str, owner: &str) -> Result<Output> {
        self.batch(id, owner)
            .await?
            .state
            .lock()
            .await
            .concat
            .clone()
            .ok_or_else(|| error(404, "RESULT_NOT_FOUND", "拼接结果不存在"))
    }
}
pub(super) type Registry = Arc<Mutex<HashMap<String, Arc<Batch>>>>;
pub(super) fn reap(
    registry: Registry,
    config: Config,
    shutdown: CancellationToken,
    tasks: &tokio_util::task::TaskTracker,
) {
    tasks.spawn(async move{loop{tokio::select!{_=shutdown.cancelled()=>return,_=tokio::time::sleep(Duration::from_secs(60))=>{}}
        // Keep eviction and file cleanup under the same registry gate so a new
        // recovery cannot reuse an old checkpoint path midway through deletion.
        let mut batches = registry.lock().await;
        let expired = {
            let ids = batches.iter().filter_map(|(id, batch)| {
                // Holding the registry excludes new lookups. The operation
                // locks cover runners, recovery, queued/active concat and saves.
                let _runner = batch.serial.try_lock().ok()?;
                let _concat = batch.concat_serial.try_lock().ok()?;
                let _checkpoint = batch.checkpoint_serial.try_lock().ok()?;
                let state = batch.state.try_lock().ok()?;
                if matches!(state.status.as_str(), "running" | "cancelling")
                    || state.concat_stage == "processing" || state.unknown
                    || batch.idle_since.lock().unwrap().elapsed() < Duration::from_secs(24 * 60 * 60)
                { return None; }
                Some(id.clone())
            }).collect::<Vec<_>>();
            ids.into_iter().filter_map(|id| batches.remove(&id)).collect::<Vec<_>>()
        };
        for batch in expired{let s=batch.state.lock().await;s.cancel.cancel();let concat=s.concat.clone();let tails=s.shots.iter().filter_map(|s|s.tail.clone()).collect::<Vec<_>>();drop(s);if let Some(Output::File{path,..})=concat{let _=tokio::fs::remove_file(path).await;}for tail in tails{if let Ok(path)=inputs::path(&config,&tail){let _=tokio::fs::remove_file(path).await;}}let _=tokio::fs::remove_file(config.runtime_root.join("jobs/video-batch").join(format!("{}.json",batch.id))).await;}
    }});
}
