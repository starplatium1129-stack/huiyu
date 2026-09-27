mod actions;
mod hooks;
mod recovery;
mod run;
use super::*;
use std::collections::HashMap;
use tokio::sync::Mutex;
pub struct BatchPrepared {
    pub input: Value,
    pub provider: String,
    first: Prepared,
    originals: inputs::Captured,
}
pub(super) struct Batch {
    pub id: String,
    pub owner: String,
    pub input: Value,
    pub created: i64,
    pub hooks: Option<Arc<dyn ExecutionHooks>>,
    state: Mutex<State>,
    serial: Mutex<()>,
    checkpoint_serial: Mutex<()>,
    concat_serial: Mutex<()>,
}
pub(super) struct State {
    status: String,
    shots: Vec<Shot>,
    concat: Option<Output>,
    concat_stage: &'static str,
    unknown: bool,
    error_code: Option<String>,
    cancel: CancellationToken,
}
#[derive(Clone)]
struct Shot {
    input: Value,
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
    async fn checkpoint(&self) -> Value {
        let s = self.state.lock().await;
        json!({"gatewayJobId":self.id,"status":s.status,"linkLastFrame":self.input["linkLastFrame"],"modelId":self.input["modelId"],"aspectRatio":self.input["aspectRatio"],"quality":self.input["quality"],"concatStage":s.concat_stage,"concat":output(&s.concat),"shots":s.shots.iter().enumerate().map(|(i,s)|json!({"index":i+1,"input":s.input,"status":s.status,"attempts":s.attempts,"upstreamId":s.upstream,"submissionIntentAt":s.intent,"gatewayJobId":s.gateway,"tailFrame":s.tail,"result":output(&s.result),"errorCode":s.code})).collect::<Vec<_>>()})
    }
    async fn save(&self) -> Result<()> {
        let _gate = self.checkpoint_serial.lock().await;
        if let Some(h) = &self.hooks {
            h.checkpoint(self.checkpoint().await).await?;
        }
        Ok(())
    }
    async fn public(&self) -> Value {
        let s = self.state.lock().await;
        json!({"id":self.id,"status":s.status,"modelId":self.input["modelId"],"aspectRatio":self.input["aspectRatio"],"quality":self.input["quality"],"steps":self.input["steps"],"linkLastFrame":self.input["linkLastFrame"],"progress":{"total":s.shots.len(),"succeeded":s.shots.iter().filter(|s|s.status=="succeeded").count(),"failed":s.shots.iter().filter(|s|s.status=="failed").count()},"createdAt":self.created,"shots":s.shots.iter().enumerate().map(|(i,s)|json!({"index":i+1,"status":s.status,"prompt":s.input["originalPrompt"],"dialogue":s.input["dialogue"],"shotSize":s.input["shotSize"],"camera":s.input["camera"],"motion":s.input["motion"],"duration":s.input["duration"],"seed":s.input["seed"],"attempts":s.attempts,"error":s.error,"code":s.code,"resultAvailable":s.result.is_some(),"resultUrl":s.result.as_ref().and(s.gateway.as_ref()).map(|id|format!("/api/video/jobs/{id}/result"))})).collect::<Vec<_>>(),"concatAvailable":s.concat.is_some(),"concatUrl":s.concat.as_ref().map(|_|format!("/api/video/batches/{}/result",self.id))})
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
        let input = batch_input::validate_batch(&raw, local)?;
        self.prepare_batch_validated(input, local, owner, cancel)
            .await
    }
    async fn prepare_batch_validated(
        &self,
        input: Value,
        local: bool,
        owner: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<BatchPrepared> {
        let shots = input["shots"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 30)
            .ok_or_else(|| error(409, "TASK_RESUME_UNSAFE", "已保存的分镜参数无效"))?;
        if input["modelId"] == "wan2.2-ti2v-5b" && input["linkLastFrame"] == true && shots.len() > 1
        {
            return Err(error(
                400,
                "MODEL_INPUT_MODE",
                "Wan 当前工作流仅支持文本分镜，请关闭尾帧衔接",
            ));
        }
        let t8 = self.t8(&cancel).await;
        for shot in shots {
            resources::plan(&self.config, shot["input"].clone(), t8, true)?;
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
        let mut combined = json!({"references":[]});
        let names = shots
            .iter()
            .flat_map(|s| inputs::names(&s["input"]))
            .collect::<Vec<_>>();
        combined["references"] = json!(names);
        let originals = inputs::capture(&self.config, &combined, local, owner, &cancel).await?;
        let first = Prepared {
            input: backend.input.clone(),
            provider: backend.provider.clone(),
            originals: originals.subset(&backend.input),
            backend,
        };
        Ok(BatchPrepared {
            input,
            provider: "comfy".into(),
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
        inputs::protect_restore(
            &self.config,
            &prepared.originals,
            hooks.as_deref(),
            &self.shutdown,
        )
        .await?;
        let shots = prepared.input["shots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| Shot {
                input: s["input"].clone(),
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
        let batch = Arc::new(Batch {
            id: uuid::Uuid::new_v4().simple().to_string(),
            owner,
            input: prepared.input,
            created: now(),
            hooks,
            state: Mutex::new(State {
                status: "running".into(),
                shots,
                concat: None,
                concat_stage: "none",
                unknown: false,
                error_code: None,
                cancel: self.shutdown.child_token(),
            }),
            serial: Mutex::new(()),
            checkpoint_serial: Mutex::new(()),
            concat_serial: Mutex::new(()),
        });
        batch.save().await?;
        self.save_batch_identity(&batch).await?;
        self.batches
            .lock()
            .await
            .insert(batch.id.clone(), batch.clone());
        self.kick(batch.clone(), Some(prepared.first));
        Ok(batch.public().await)
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
        if let Some(batch) = self
            .batches
            .lock()
            .await
            .get(id)
            .filter(|b| b.owner == owner)
            .cloned()
        {
            return Ok(batch);
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
        Ok(self.batch(id, owner).await?.public().await)
    }
    pub async fn batch_checkpoint(&self, id: &str, owner: &str) -> Result<Value> {
        Ok(self.batch(id, owner).await?.checkpoint().await)
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
        let expired={let mut batches=registry.lock().await;let ids=batches.iter().filter(|(_,b)|now()-b.created>=86400*1000).map(|(id,_)|id.clone()).collect::<Vec<_>>();ids.into_iter().filter_map(|id|batches.remove(&id)).collect::<Vec<_>>()};
        for batch in expired{let s=batch.state.lock().await;s.cancel.cancel();let concat=s.concat.clone();let tails=s.shots.iter().filter_map(|s|s.tail.clone()).collect::<Vec<_>>();drop(s);if let Some(Output::File{path,..})=concat{let _=tokio::fs::remove_file(path).await;}for tail in tails{if let Ok(path)=inputs::path(&config,&tail){let _=tokio::fs::remove_file(path).await;}}let _=tokio::fs::remove_file(config.runtime_root.join("jobs/video-batch").join(format!("{}.json",batch.id))).await;}
    }});
}
