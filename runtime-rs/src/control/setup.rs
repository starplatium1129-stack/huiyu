use super::*;
use std::{collections::BTreeSet, path::Path};

const RECOMMENDED_MODEL: &str = "anima-aesthetic-v1.1";

// Compile the real, no-LoRA baseline. This is inspection only: never submit a
// prompt or silently change the user's selected model, draft, or defaults.
fn baseline_workflow() -> Result<Value> {
    let input = crate::images::validate(
        &json!({"modelId":RECOMMENDED_MODEL,"prompt":"landscape","width":1024,
            "height":1024,"seed":0,"teaCache":false,"hiresFix":false}),
        "anima",
        true,
    )?;
    crate::images::build_workflow(&input)
}

async fn presence(path: &Path, directory: bool) -> (&'static str, Option<u64>) {
    match tokio::fs::metadata(path).await {
        Ok(meta) if directory && meta.is_dir() => ("present", None),
        Ok(meta) if !directory && meta.is_file() => {
            // Empty placeholder/partial files are not a usable model. A nonzero
            // length still makes no checksum, format, or loadability claim.
            (
                if meta.len() > 0 { "present" } else { "unknown" },
                Some(meta.len()),
            )
        }
        Ok(_) => ("missing", None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ("missing", None),
        Err(_) => ("unknown", None),
    }
}

fn valid_stats(response: &Result<(u16, Option<Value>)>) -> Option<&Value> {
    match response {
        Ok((200..=299, Some(value)))
            if value["system"].is_object() && value["devices"].is_array() =>
        {
            Some(value)
        }
        _ => None,
    }
}

fn bytes(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
}

impl ControlService {
    pub(super) async fn local_setup(&self) -> Result<Value> {
        let graph = baseline_workflow()?;
        let required: BTreeSet<_> = graph
            .as_object()
            .unwrap()
            .values()
            .filter_map(|node| node["class_type"].as_str().map(str::to_owned))
            .collect();
        // Snapshot active settings, not saved configuration pending a restart.
        let host = self.settings()["comfyHost"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let (stats, node_response) = tokio::join!(
            self.request(&host, "/system_stats", None, 3),
            self.request(&host, "/object_info", None, 5),
        );
        let stats_value = valid_stats(&stats);
        let connection = if stats_value.is_some() {
            "online"
        } else if stats
            .as_ref()
            .is_err_and(|e| matches!(e.code.as_str(), "UPSTREAM_UNAVAILABLE" | "UPSTREAM_TIMEOUT"))
        {
            "offline"
        } else {
            "unknown"
        };
        let node_info = match &node_response {
            Ok((200..=299, Some(value))) => value.as_object().filter(|map| {
                !map.is_empty() && map.values().all(|node| node["input"].is_object())
            }),
            _ => None,
        };
        let missing: Vec<_> = node_info
            .map(|info| {
                required
                    .iter()
                    .filter(|name| !info.contains_key(name.as_str()))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        let workspace = &self.config.ai_workspace_root;
        let comfy = workspace.join("ComfyUI");
        let (workspace_state, _) = presence(workspace, true).await;
        let (installation, _) = presence(&comfy.join("main.py"), false).await;
        let venv = presence(&comfy.join("venv/Scripts/python.exe"), false)
            .await
            .0
            == "present"
            || presence(&comfy.join("venv/bin/python"), false).await.0 == "present";
        let external_venv = presence(&comfy.join(".venv/Scripts/python.exe"), false)
            .await
            .0
            == "present";
        let portable = presence(&workspace.join("python_embeded/python.exe"), false)
            .await
            .0
            == "present";

        let catalog = crate::images::catalog();
        let model = &catalog["MODELS"][RECOMMENDED_MODEL];
        let model_file = graph["1"]["inputs"]["unet_name"].as_str().unwrap();
        let encoder = graph["2"]["inputs"]["clip_name"].as_str().unwrap();
        let vae = graph["3"]["inputs"]["vae_name"].as_str().unwrap();
        let mut files = vec![
            (
                RECOMMENDED_MODEL,
                model["label"].as_str().unwrap(),
                "diffusion_models",
                model_file,
                true,
            ),
            (
                "qwen-encoder",
                "Qwen 文本编码器",
                "text_encoders",
                encoder,
                true,
            ),
            ("qwen-vae", "Qwen Image VAE", "vae", vae, true),
        ];
        for (id, model) in catalog["MODELS"].as_object().unwrap() {
            if model["family"] == "anima" && id != RECOMMENDED_MODEL {
                files.push((
                    id,
                    model["label"].as_str().unwrap(),
                    "diffusion_models",
                    model["file"].as_str().unwrap(),
                    false,
                ));
            }
        }
        // One pinned source shared with the maintenance downloader. Never fetch
        // metadata/weights or infer license acceptance while inspecting setup.
        let manifest: Value = serde_json::from_str(include_str!("setup-models.json"))?;
        let mut models = Vec::new();
        for (id, label, kind, name, required) in files {
            let path = comfy.join("models").join(kind).join(name);
            let (state, size) = presence(&path, false).await;
            let relative = format!("{kind}/{name}");
            let preparation = manifest["files"].as_array().unwrap().iter()
                .find(|entry| entry["path"] == relative).map(|entry| {
                    json!({"url":format!("https://huggingface.co/{}/resolve/{}/{}",
                        entry["repo"].as_str().unwrap(), entry["revision"].as_str().unwrap(), entry["remotePath"].as_str().unwrap()),
                        "modelCardUrl":manifest["modelCardUrl"],"licenseUrl":manifest["licenseUrl"],
                        "upstreamLicenseUrl":entry["upstreamLicenseUrl"],"revision":entry["revision"],"expectedBytes":entry["bytes"],"sha256":entry["sha256"]})
                });
            models.push(json!({"id":id,"label":label,"path":path,"state":state,"bytes":size,"required":required,"preparation":preparation}));
        }

        let ram = stats_value.and_then(|s| bytes(&s["system"]["ram_total"]));
        let devices: Vec<_> = stats_value.and_then(|s| s["devices"].as_array()).into_iter().flatten()
            .filter_map(|device| {
                let name = device["name"].as_str()?.trim();
                let kind = device["type"].as_str()?.trim();
                if name.is_empty() || kind.is_empty() { return None; }
                Some(json!({"name":self.redact(&name.chars().take(160).collect::<String>()),
                    "type":kind.chars().take(32).collect::<String>(),"vramBytes":bytes(&device["vram_total"])}))
            }).collect();
        Ok(json!({"ok":true,"checkedAt":now(),
            "workspace":{"path":workspace,"state":workspace_state},
            "comfy":{"path":comfy,"installation":installation,"layout":if venv{"venv"}else if external_venv{"external-venv"}else if portable{"portable"}else{"unrecognized"},"host":host,"connection":connection},
            "models":models,"nodes":{"state":if node_info.is_some(){"checked"}else{"unknown"},"required":required,"missing":missing},
            "hardware":{"state":if ram.is_some()||!devices.is_empty(){"reported"}else{"unknown"},"devices":devices,"ramBytes":ram}}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn setup_reports_missing_files_unknown_hardware_and_real_required_nodes() {
        let (temp, service) = super::super::tests::fixture(json!({"credential":"not-for-setup"}));
        let report = service.local_setup().await.unwrap();
        assert_eq!(report["workspace"]["state"], "missing");
        assert_eq!(report["comfy"]["installation"], "missing");
        assert_eq!(report["comfy"]["connection"], "offline");
        assert_eq!(
            report["models"][0]["preparation"]["expectedBytes"],
            4182230656_u64
        );
        assert_eq!(
            report["models"][0]["preparation"]["sha256"],
            "3c1868387a3a1ff504bbb87c33678321965ead381fcf87afbd0264daa600c082"
        );
        for model in report["models"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["required"] == true)
        {
            let source = &model["preparation"];
            assert!(
                source["url"]
                    .as_str()
                    .unwrap()
                    .contains(source["revision"].as_str().unwrap())
            );
            assert!(
                source["url"].as_str().unwrap().ends_with(
                    Path::new(model["path"].as_str().unwrap())
                        .file_name()
                        .unwrap()
                        .to_str()
                        .unwrap()
                )
            );
        }
        assert_eq!(report["nodes"]["state"], "unknown");
        assert_eq!(report["hardware"]["state"], "unknown");
        assert!(report["hardware"]["ramBytes"].is_null());
        assert!(
            report["nodes"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("ImageSharpenKJ"))
        );
        assert!(
            !report["nodes"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("AnimaTeaCache"))
        );
        assert!(!report.to_string().contains("not-for-setup"));
        assert!(
            !temp.path().join("AI").exists(),
            "checking must not create directories"
        );
        service.close().await;
    }

    #[tokio::test]
    async fn setup_distinguishes_online_nodes_model_presence_and_portable_layout() {
        use axum::{Json, Router, routing::get};
        let (temp, service) = super::super::tests::fixture(json!({}));
        let root = temp.path().join("AI");
        for name in [
            "ComfyUI/main.py",
            "python_embeded/python.exe",
            "ComfyUI/models/diffusion_models/anima-aesthetic-v1.1.safetensors",
        ] {
            let file = root.join(name);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"fixture, not verified weights").unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        service.settings.write().unwrap()["comfyHost"] =
            json!(format!("http://{}", listener.local_addr().unwrap()));
        let upstream = tokio::spawn(async move {
            axum::serve(listener, Router::new()
                .route("/system_stats", get(|| async { Json(json!({"system":{"ram_total":17179869184_u64},"devices":[{"name":"Fixture GPU","type":"cuda","vram_total":8589934592_u64}]})) }))
                .route("/object_info", get(|| async { Json(json!({"UNETLoader":{"input":{}}})) })))
                .await.unwrap();
        });
        let report = service.local_setup().await.unwrap();
        assert_eq!(report["comfy"]["connection"], "online");
        assert_eq!(report["comfy"]["layout"], "portable");
        assert_eq!(report["models"][0]["state"], "present");
        assert_eq!(report["models"][1]["state"], "missing");
        assert_eq!(report["nodes"]["state"], "checked");
        assert!(
            report["nodes"]["missing"]
                .as_array()
                .unwrap()
                .contains(&json!("ImageSharpenKJ"))
        );
        assert!(
            !report["nodes"]["missing"]
                .as_array()
                .unwrap()
                .contains(&json!("UNETLoader"))
        );
        assert_eq!(
            report["hardware"]["devices"][0]["vramBytes"],
            8589934592_u64
        );
        assert_eq!(report["hardware"]["ramBytes"], 17179869184_u64);
        let interpreter = root.join("ComfyUI/.venv/Scripts/python.exe");
        std::fs::create_dir_all(interpreter.parent().unwrap()).unwrap();
        std::fs::write(&interpreter, b"fixture").unwrap();
        assert_eq!(
            service.local_setup().await.unwrap()["comfy"]["layout"],
            "external-venv"
        );
        service.close().await;
        upstream.abort();
    }
}
