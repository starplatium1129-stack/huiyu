use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use tokio_util::sync::CancellationToken;

enum Destination {
    ChatGpt {
        client_id: String,
        model: String,
        label: String,
    },
    Api(validation::Api),
}

pub(crate) struct VisionRoute(Destination);

impl VisionRoute {
    pub(crate) fn provider(&self) -> &'static str {
        match self.0 {
            Destination::ChatGpt { .. } => "chatgpt",
            Destination::Api(_) => "api",
        }
    }

    pub(crate) fn model(&self) -> &str {
        match &self.0 {
            Destination::ChatGpt { model, .. } => model,
            Destination::Api(api) => &api.model,
        }
    }

    /// Stable, secret-free cache scope identifier for this vision route.
    pub(crate) fn cache_identity(&self) -> String {
        match &self.0 {
            Destination::ChatGpt { model, .. } => format!("chatgpt:{model}"),
            Destination::Api(api) => {
                use sha2::{Digest, Sha256};
                let endpoint = format!("{}{}", api.base_url, api.pathname);
                let hash = format!("{:x}", Sha256::digest(endpoint.as_bytes()));
                format!("api:{}:{}", api.model, &hash[..16])
            }
        }
    }

    pub(crate) fn status(route: Option<&Self>) -> Value {
        let Some(route) = route else {
            return json!({"available":false,"provider":null,"model":null,"label":null});
        };
        let label = match &route.0 {
            Destination::ChatGpt { label, .. } => label,
            Destination::Api(api) => &api.model,
        };
        json!({"available":true,"provider":route.provider(),"model":route.model(),"label":label})
    }
}

impl ChatService {
    pub(crate) async fn vision_route(
        &self,
        app: &AppState,
        headers: &HeaderMap,
    ) -> Option<VisionRoute> {
        let settings = self.settings(app).await;
        if let Some((client_id, model, label)) = self.chatgpt.vision_selection(settings).await {
            return Some(VisionRoute(Destination::ChatGpt {
                client_id,
                model,
                label,
            }));
        }
        if let Some(api) = settings.read_host().await {
            let target = url::Url::parse(&api.base_url)
                .ok()
                .and_then(|base| base.join(&api.pathname).ok());
            if target.as_ref().is_some_and(|target| {
                validation::api(&json!({
                    "baseUrl":target.as_str(), "model":api.model, "apiKey":api.key,
                }))
                .is_ok()
            }) {
                return Some(VisionRoute(Destination::Api(api)));
            }
        }
        // The local drawing UI can hand off its already-saved personal settings
        // when there is no host configuration. Status sends metadata only.
        let header = headers.get("x-aics-interrogate-api")?;
        if header.as_bytes().len() > 8192 {
            return None;
        }
        let bytes = STANDARD.decode(header.as_bytes()).ok()?;
        let data = serde_json::from_slice(&bytes).ok()?;
        validation::api(&data)
            .ok()
            .map(|api| VisionRoute(Destination::Api(api)))
    }

    pub(crate) async fn vision_complete(
        self: &Arc<Self>,
        app: &AppState,
        route: VisionRoute,
        messages: Vec<Value>,
        cancel: &CancellationToken,
    ) -> crate::error::Result<String> {
        let work = async {
            running(app)?;
            let admission = request_body::admit(cancel).await?;
            let settings = self.settings(app).await;
            let mut input = validation::Input {
                model: route.model().to_owned(),
                session_id: uuid::Uuid::new_v4().to_string(),
                api: None,
                tool_result_origin: None,
                tools: false,
                channel_tools: false,
                channel_voice: false,
                japanese_voice: false,
                card_tools: false,
                web_search: false,
                reasoning: "off".into(),
                sampling: validation::SamplingOptions::default(),
                disable_bubble_split: false,
                matched_lore: Vec::new(),
                messages,
            };
            let prepared = match route.0 {
                Destination::ChatGpt { client_id, .. } => {
                    input.reasoning = "low".into();
                    responses::prepare(
                        self,
                        settings,
                        input,
                        Some(&client_id),
                        Some(&admission),
                        cancel,
                    )
                    .await?
                }
                Destination::Api(api) => {
                    input.api = Some(validation::ApiSource::Personal(api));
                    let managed = app.control.as_ref().map(|control| control.llama_auth());
                    compatible::prepare(
                        &self.transport,
                        settings,
                        input,
                        false,
                        managed.as_ref(),
                        Some(&admission),
                        cancel,
                    )
                    .await?
                }
            };
            stream::collect_vision(prepared, cancel.clone()).await
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(crate::error::ApiError::new(499, "ABORT_ERR", "视觉协同已取消")),
            result = work => result.map_err(|error| crate::error::ApiError::new(error.status.as_u16(), error.code, error.message)),
        }
    }
}
