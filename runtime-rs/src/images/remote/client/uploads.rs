use super::*;
use std::collections::HashMap;

impl Client {
    pub(super) async fn prepare_uploads(
        &self,
        raw: &mut Value,
        originals: &[inputs::Original],
        route: &str,
        cancel: &CancellationToken,
    ) -> Result<()> {
        if originals.is_empty() {
            return Ok(());
        }
        let mut unique = HashMap::new();
        for (index, original) in originals.iter().enumerate() {
            original.input.check()?;
            unique.entry(original.input.hash.as_str()).or_insert(index);
        }
        let mut found = HashMap::<String, String>::new();
        if self.reuse_supported.load(Ordering::Relaxed) {
            let hashes = json!(unique.keys().collect::<Vec<_>>());
            match self
                .json(
                    Method::POST,
                    super::super::upload_index::PATH,
                    Some(&hashes),
                    cancel,
                )
                .await
            {
                Ok(value) => {
                    found =
                        serde_json::from_value(value["inputs"].clone()).map_err(|_| protocol())?;
                    if found.iter().any(|(hash, name)| {
                        !unique.contains_key(hash.as_str()) || !inputs::valid_name(name)
                    }) {
                        return Err(protocol());
                    }
                }
                Err(error) if matches!(error.status.as_u16(), 404 | 405) => {
                    self.reuse_supported.store(false, Ordering::Relaxed);
                }
                Err(error) => return Err(error),
            }
        }
        let missing: Vec<_> = unique
            .into_iter()
            .filter_map(|(hash, index)| (!found.contains_key(hash)).then_some(index))
            .collect();
        let path = format!("/api/{route}/images/raw");
        let path = path.as_str();
        let mut pending = stream::iter(missing)
            .map(|index| async move {
                self.upload(&originals[index], path, cancel)
                    .await
                    .map(|name| (originals[index].input.hash.clone(), name))
            })
            .buffer_unordered(UPLOAD_PARALLELISM);
        while let Some((hash, name)) = pending.try_next().await? {
            found.insert(hash, name);
        }
        let mut names = HashMap::new();
        for original in originals {
            names.insert(
                original.name.as_str(),
                found.get(&original.input.hash).ok_or_else(protocol)?,
            );
        }
        let replace = |value: &mut Value| {
            if let Some(name) = value.as_str().and_then(|key| names.get(key)) {
                *value = json!(name);
            }
        };
        for key in ["initImage", "maskImage", "penLines"] {
            if let Some(value) = raw.get_mut(key) {
                replace(value);
            }
        }
        if let Some(value) = raw
            .get_mut("sketchControl")
            .and_then(|control| control.get_mut("image"))
        {
            replace(value);
        }
        if let Some(references) = raw.get_mut("referenceImages").and_then(Value::as_array_mut) {
            references.iter_mut().for_each(replace);
        }
        Ok(())
    }

    async fn upload(
        &self,
        original: &inputs::Original,
        path: &str,
        cancel: &CancellationToken,
    ) -> Result<String> {
        let _permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(inputs::cancelled()),
            permit = self.uploads.acquire() => permit.map_err(|_| unavailable())?,
        };
        let bytes = original.input.read_verified(cancel).await?;
        let uploaded = self
            .bytes(
                Method::POST,
                path,
                Some(bytes),
                "application/octet-stream",
                65536,
                cancel,
            )
            .await?;
        let response: Value = serde_json::from_slice(&uploaded).map_err(|_| protocol())?;
        self.reuse_supported
            .store(response["inputReuse"] == true, Ordering::Relaxed);
        response["name"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .map(str::to_owned)
            .ok_or_else(protocol)
    }
}
