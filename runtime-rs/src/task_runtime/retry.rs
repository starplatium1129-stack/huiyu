//! Explicit native retries create one durable child per failed task.
use super::*;
use submission::Submission;

impl TaskRuntime {
    pub async fn retry_manga(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        id: String,
    ) -> Result<Value> {
        self.check_running()?;
        // Authorize before creating an operation lock or inspecting a lineage.
        if !Self::get(&storage, &principal, &id).await?.kind.is_manga() {
            return Err(ApiError::invalid("一键重试仅用于漫画化和独立线稿任务"));
        }
        let operation = self
            .jobs
            .lock()
            .unwrap()
            .entry(identity(&storage, &id))
            .or_insert_with(|| JobBinding::new(String::new()))
            .operation
            .clone();
        let guard = operation.try_lock_owned().map_err(|_| {
            ApiError::new(
                409,
                "TASK_ACTION_BUSY",
                "这条任务正在核对或准备重试，请稍后查询原操作",
            )
        })?;
        let (reply, received) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        // Own restoration and acceptance even if the HTTP caller disappears.
        self.tracker.spawn(async move {
            let _guard = guard;
            let result = runtime.prepare_manga_retry(&storage, &principal, &id).await;
            let mut jobs = runtime.jobs.lock().unwrap();
            let key = identity(&storage, &id);
            if jobs
                .get(&key)
                .is_some_and(|job| job.id.is_empty() && !job.dispatching && !job.watching)
            {
                jobs.remove(&key);
            }
            drop(jobs);
            let _ = reply.send(result);
        });
        received.await.map_err(|_| {
            ApiError::new(
                503,
                "TASK_ACCEPT_UNKNOWN",
                "重试接收状态未知，请查询原任务的重试记录",
            )
        })?
    }

    async fn prepare_manga_retry(
        self: &Arc<Self>,
        storage: &Storage,
        principal: &str,
        id: &str,
    ) -> Result<Value> {
        self.check_running()?;
        let source = Self::get(storage, principal, id).await?;
        let key = format!("manga-retry:{id}");
        let existing: Option<TaskRecord> = serde_json::from_value(
            storage
                .task(
                    TaskCommand::Get {
                        task_id: None,
                        request_key: Some(key.clone()),
                        summary: false,
                    },
                    principal,
                )
                .await?,
        )?;
        if let Some(existing) = existing {
            if !source.kind.is_manga()
                || existing.kind != source.kind
                || existing.provider != "native"
                || existing.input != source.input
                || existing.metadata.get("retryOfTaskId") != Some(&json!(id))
            {
                return Err(ApiError::new(
                    409,
                    "TASK_KEY_CONFLICT",
                    "重试编号已被其他操作使用，请核对原任务",
                ));
            }
            return Ok(existing.into_value()?);
        }
        if !source.can_retry_manga() {
            return Err(ApiError::new(
                409,
                "TASK_RETRY_UNSAFE",
                "仅已确认结束的失败或重启中断漫画/线稿任务可重试；状态未知时请先重新核对",
            ));
        }
        if source.provider_fingerprint != self.binding_for(source.kind) {
            return Err(ApiError::new(
                409,
                "TASK_RETRY_PROVIDER_CHANGED",
                "原生运行环境已改变，请恢复原配置，或回到漫画化入口创建新任务",
            ));
        }
        let hooks = hooks::Hooks {
            runtime: Arc::downgrade(self),
            storage: storage.clone(),
            principal: principal.into(),
            id: id.into(),
        };
        // This path restores and validates the protected bytes. It neither
        // uploads a browser copy nor substitutes today's default parameters.
        let cancel = self.shutdown.child_token();
        let prepared = tokio::time::timeout(
            std::time::Duration::from_secs(120),
            self.images.resume_prepared(
                Value::Object(source.input.clone()),
                &hooks,
                cancel.clone(),
            ),
        )
        .await
        .map_err(|_| {
            cancel.cancel();
            ApiError::new(
                408,
                "TASK_RETRY_PREPARE_TIMEOUT",
                "读取原任务素材超时，尚未接收重试；请核对工作区磁盘后再试",
            )
        })?
        .map_err(|error| {
            // Restoration has not reached acceptance. Missing local models or
            // files are definite rejections, not an unknown submission receipt.
            if error.status.is_server_error() {
                ApiError::new(422, error.code, error.message)
            } else {
                error
            }
        })?;
        if prepared.input != Value::Object(source.input.clone()) {
            return Err(ApiError::new(
                409,
                "TASK_RESUME_UNSAFE",
                "已保存的漫画配方不能原样恢复，请回入口重新创建任务",
            ));
        }
        let context = source.metadata.get("context").cloned().unwrap_or(json!({}));
        let fingerprint = self.fingerprint.hash(
            &json!({"kind":source.kind,"input":source.input,"context":context,"retryOfTaskId":id}),
        );
        self.accept_prepared(
            storage.clone(),
            principal.into(),
            Preparation::Image(prepared),
            Submission {
                kind: source.kind,
                key,
                fingerprint,
                context,
                retry_of: Some(id.into()),
            },
        )
        .await
    }
}
