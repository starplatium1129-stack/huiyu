use super::{OpsLimits, PART_BYTES, READ_PRINCIPAL, json_response};
use crate::AppState;
use axum::{Extension, extract::State, response::Response};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

fn count_models(models: Option<&Vec<Value>>) -> (usize, usize) {
    let Some(models) = models else {
        return (0, 0);
    };
    let available = models.iter().filter(|m| m["available"] == true).count();
    (available, models.len())
}

pub(super) async fn health(
    State(state): State<AppState>,
    Extension(limits): Extension<Arc<OpsLimits>>,
) -> Response {
    if let Some(limited) = limits.health.check(false) {
        return limited;
    }
    json_response(
        async {
            state.host.check_running()?;

            let mut image_engine = "off".to_owned();
            let mut video_engine = "off".to_owned();
            let mut acceleration = "native".to_owned();
            let mut memory_policy = "auto".to_owned();
            let mut image_online = false;
            let mut image_avail = 0usize;
            let mut image_total = 0usize;
            let mut image_pending = 0usize;
            let mut gpu_owned = false;

            if let Some(images) = state.images.as_ref() {
                gpu_owned = images.native_gpu_owned();
                image_pending = images.backend.pending();
                if let Ok(settings) = images.backend.native_settings() {
                    image_engine = settings.engine.clone();
                    if let Some(v_eng) = settings.video_engine.as_deref() {
                        video_engine = v_eng.to_owned();
                    } else if state.video.is_some() {
                        video_engine = if settings.engine == "native" {
                            "native".into()
                        } else {
                            "comfy".into()
                        };
                    }
                    acceleration = settings.acceleration;
                    memory_policy = settings.memory_policy;
                }
                if image_engine == "native" {
                    let cancel = state.shutdown.child_token();
                    let _guard = cancel.clone().drop_guard();
                    if let Ok(Ok(status)) = tokio::time::timeout(
                        Duration::from_secs(3),
                        crate::images::native::status(&images.backend, "", cancel),
                    )
                    .await
                    {
                        let (avail, total) = count_models(status["models"].as_array());
                        image_avail = avail;
                        image_total = total;
                        image_online = status["online"] == true || avail > 0;
                    }
                } else if let Ok(Ok(status)) =
                    tokio::time::timeout(Duration::from_secs(3), images.get_status("anima")).await
                {
                    let (avail, total) = count_models(status["models"].as_array());
                    image_avail = avail;
                    image_total = total;
                    image_online = status["online"] == true;
                }
            }

            let mut video_online = false;
            let mut video_avail = 0usize;
            let mut video_total = 0usize;
            let mut video_h3_dwd = false;
            let mut video_pending = 0u64;
            if let Some(video) = state.video.as_ref() {
                if let Ok(Ok(status)) =
                    tokio::time::timeout(Duration::from_secs(3), video.get_status()).await
                {
                    if let Some(engine) = status["engine"].as_str() {
                        video_engine = engine.to_owned();
                    }
                    video_online = status["online"] == true;
                    video_pending = status["pending"].as_u64().unwrap_or(0);
                    let (avail, total) = count_models(status["models"].as_array());
                    video_avail = avail;
                    video_total = total;
                    video_h3_dwd = status["models"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|m| m["id"] == "minimax-h3" && m["h3Dwd"] == true);
                }
            }

            let voice_enabled = state.voice.is_some();
            let (voice_engine_id, voice_available, voice_native_ready) =
                if let Some(voice) = state.voice.as_ref() {
                    let id = voice.engine_id();
                    let native_ready = voice.native_ready();
                    let available = match id {
                        "off" | "system" => false,
                        "native" | "qwen-tts" | "gpt-sovits" => {
                            native_ready || voice.native_files_present()
                        }
                        "openai" => voice.openai_configured(),
                        _ => true,
                    };
                    (id, available, native_ready)
                } else {
                    ("off", false, false)
                };

            let interrogate_enabled = state.interrogate.is_some();
            let desktop_chat_enabled = state.chat.is_some();
            let live2d_available = state
                .live2d
                .as_ref()
                .is_some_and(|service| service.health_status()["available"] == true);
            let qq_vm_configured =
                crate::companion_channels::muse_vm_peer(&state.config.runtime_root)
                    .await
                    .ok()
                    .flatten()
                    .is_some();

            let workspace = state.host.storage();
            let workspace_available = workspace.is_some();
            let gallery_artworks = if let Some(storage) = workspace.as_ref() {
                tokio::time::timeout(
                    Duration::from_secs(2),
                    storage.request(
                        json!({"kind": "readGalleryPage", "query": {}, "limit": 1}),
                        READ_PRINCIPAL,
                    ),
                )
                .await
                .ok()
                .and_then(|res| res.ok())
                .and_then(|val| val["total"].as_i64())
            } else {
                None
            };

            Ok(json!({
                "online": true,
                "app": "ai-cg-studio",
                "runtime": "rust",
                "protocolVersion": 1,
                "serverNow": crate::host::now_ms(),
                "remoteListening": super::super::listening(),
                "inference": {
                    "imageEngine": image_engine,
                    "videoEngine": video_engine,
                    "acceleration": acceleration,
                    "memoryPolicy": memory_policy,
                    "gpuOwned": gpu_owned
                },
                "modules": {
                    "image": {
                        "enabled": state.images.is_some(),
                        "online": image_online,
                        "engine": image_engine,
                        "availableModels": image_avail,
                        "totalModels": image_total,
                        "pending": image_pending
                    },
                    "video": {
                        "enabled": state.video.is_some(),
                        "online": video_online,
                        "engine": video_engine,
                        "availableModels": video_avail,
                        "totalModels": video_total,
                        "h3Dwd": video_h3_dwd,
                        "pending": video_pending
                    },
                    "interrogate": {
                        "enabled": interrogate_enabled,
                        "available": interrogate_enabled
                    },
                    "voice": {
                        "enabled": voice_enabled,
                        "available": voice_available,
                        "engineId": voice_engine_id,
                        "nativeReady": voice_native_ready
                    },
                    "qq": {
                        "enabled": true,
                        "vmConfigured": qq_vm_configured
                    },
                    "desktop": {
                        "chatEnabled": desktop_chat_enabled,
                        "workspaceAvailable": workspace_available,
                        "live2dAvailable": live2d_available
                    }
                },
                "counts": {
                    "imageModelsAvailable": image_avail,
                    "imageModelsTotal": image_total,
                    "videoModelsAvailable": video_avail,
                    "videoModelsTotal": video_total,
                    "galleryArtworks": gallery_artworks
                },
                "capabilities": {
                    "image": state.images.is_some(),
                    "video": state.video.is_some(),
                    "videoH3Dwd": video_h3_dwd,
                    "videoBatch": state.video.is_some(),
                    "interrogate": interrogate_enabled,
                    "voice": voice_enabled && voice_available,
                    "qq": true,
                    "desktopChat": desktop_chat_enabled,
                    "gallery": workspace_available,
                    "partDownload": true,
                    "rangeDownload": true,
                    "partBytes": PART_BYTES
                }
            }))
        }
        .await,
    )
}
