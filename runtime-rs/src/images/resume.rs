use super::*;

impl Service {
    pub(crate) async fn resume_prepared(
        &self,
        input: Value,
        hooks: &dyn ExecutionHooks,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        if self.native != (input["inferenceEngine"] == "native") {
            return Err(ApiError::new(
                409,
                "TASK_RESUME_UNSAFE",
                "任务推理引擎已改变",
            ));
        }
        if self.remote.is_some() {
            let family = input["family"]
                .as_str()
                .ok_or_else(|| ApiError::new(409, "TASK_RESUME_UNSAFE", "远程任务缺少模型类型"))?
                .to_owned();
            remote::Client::check_family(&family)?;
            for name in inputs::input_names(&input) {
                if !hooks
                    .restore_input(name.into(), inputs::path_for(&self.config, name, true)?)
                    .await?
                {
                    return Err(ApiError::new(
                        409,
                        "TASK_RESUME_UNSAFE",
                        "远程任务缺少受保护的原始输入图像",
                    ));
                }
            }
            let keys: Vec<&str> =
                if generation::native::adapters::model(input["modelId"].as_str().unwrap_or(""))
                    .is_some()
                {
                    native_adapters::KEYS.to_vec()
                } else {
                    catalog::contract()["ALLOWED_INPUT_KEYS"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str)
                        .collect()
                };
            let mut raw = Value::Object(
                keys.into_iter()
                    .filter_map(|key| {
                        input
                            .get(key)
                            .filter(|value| !value.is_null())
                            .map(|value| (key.into(), value.clone()))
                    })
                    .collect(),
            );
            if input["teaCacheAuto"] == true {
                raw.as_object_mut().unwrap().remove("teaCache");
            }
            let prepared = self.prepare_owned(raw, &family, true, None, cancel).await?;
            if prepared.input() != &input {
                return Err(ApiError::new(
                    409,
                    "TASK_RESUME_UNSAFE",
                    "恢复后的参数与原任务不一致，请重新创建任务",
                ));
            }
            return Ok(prepared);
        }
        // Restore/capture can copy two full images. Reserve the same queue slot
        // before either operation, then transfer it into the prepared job.
        let permit = if self.native {
            Some(self.backend.reserve_native(&cancel)?)
        } else {
            None
        };
        for name in inputs::input_names(&input) {
            // Restore the accepted bytes before the resource probe. A stale
            // working copy must not change the resumed input silently.
            let restored = hooks
                .restore_input(
                    name.into(),
                    inputs::path_for(&self.config, name, self.native)?,
                )
                .await?;
            if self.native && !restored {
                return Err(ApiError::new(
                    409,
                    "TASK_RESUME_UNSAFE",
                    "独立推理缺少受保护的原始输入图像",
                ));
            }
        }
        let originals = inputs::capture(&self.config, &input, true, None, &cancel).await?;
        let prepared = if let Some(permit) = permit {
            let plan = native::plan(&self.backend.native_settings()?, input, &originals).await?;
            self.backend.prepare_native(plan, permit, &cancel)?
        } else {
            let plan = resources::frozen_plan(&self.config, input).await?;
            self.backend.prepare_comfy(plan, cancel.clone()).await?
        };
        Ok(Prepared {
            backend: PreparedBackend::Local(prepared),
            originals,
        })
    }
}
