use super::{Http, family, job_response, response};
use crate::{
    AppState,
    images::{
        ApiError, CancellationToken, ExecutionHooks, Output, Result, Service, generation, inputs,
        remote, upload_body::RawUploadBody,
    },
    security,
};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, OriginalUri, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
};

pub(super) async fn upload_raw(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    OriginalUri(uri): OriginalUri,
    reuse: Option<Extension<Arc<remote::UploadIndex>>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    RawUploadBody(bytes, admission): RawUploadBody,
) -> Response {
    if let Err(error) = state.host.check_running() {
        return error.into_response();
    }
    if let Err(error) = http.service.check_keyframe_engine(family(&uri)) {
        return error.into_response();
    }
    let owner = generation::request_owner(&headers, peer, &query);
    let indexed = reuse.is_some();
    let result = http
        .service
        .upload(
            bytes,
            owner,
            http.service.shutdown.child_token(),
            admission,
            reuse.map(|Extension(index)| index),
        )
        .await
        .map(|name| {
            if indexed {
                json!({"name":name,"inputReuse":true})
            } else {
                json!({"name":name})
            }
        });
    response(result, StatusCode::OK)
}
struct SubmissionGuard {
    service: Arc<Service>,
    owner: String,
    family: &'static str,
    job: Arc<Mutex<Option<String>>>,
    cancel: CancellationToken,
    armed: bool,
}
impl Drop for SubmissionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.cancel.cancel();
        let job = self.job.lock().unwrap().clone();
        if let Some(id) = job {
            let service = self.service.clone();
            let owner = self.owner.clone();
            let family = self.family;
            tokio::spawn(async move {
                let _ = service.cancel(&id, &owner, family).await;
            });
        }
    }
}
struct LegacyObservation {
    job: Arc<Mutex<Option<String>>>,
    cancel: CancellationToken,
}
impl LegacyObservation {
    fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            Err(inputs::cancelled())
        } else {
            Ok(())
        }
    }
}
impl ExecutionHooks for LegacyObservation {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            *self.job.lock().unwrap() = value["gatewayJobId"].as_str().map(str::to_owned);
            self.check()
        })
    }
    fn submitting(&self, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.check() })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn collect(&self, _: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}
pub(super) async fn create(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    guest: Option<Extension<crate::guest_share::Guest>>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(error) = state.host.check_running() {
        return error.into_response();
    }
    let local = security::is_direct_local(&headers, peer.ip());
    let family = family(&uri);
    let owner = generation::request_owner(&headers, peer, &query);
    if guest.is_some() {
        let input = guest_input(&state, &http.service, &body).await;
        let result = match input {
            Ok((key, input)) if !http.service.is_remote() => {
                http.service
                    .accept_request(input, key, owner, "anima", false)
                    .await
            }
            Ok(_) => Err(ApiError::new(
                409,
                "SHARE_LOCAL_GPU_REQUIRED",
                "房主需切换到本机出图服务",
            )),
            Err(error) => Err(error),
        };
        return job_response(result, StatusCode::ACCEPTED, true);
    }
    if let Some(key) = body.get("requestKey") {
        let result = match key.as_str().map(str::to_owned) {
            Some(key) => {
                http.service
                    .accept_request(body, key, owner, family, local)
                    .await
            }
            None => Err(ApiError::invalid("图片请求编号无效")),
        };
        return response(result, StatusCode::ACCEPTED);
    }
    let cancellation = http.service.shutdown.child_token();
    let job = Arc::new(Mutex::new(None));
    let mut guard = SubmissionGuard {
        service: http.service.clone(),
        owner: owner.clone(),
        family,
        job: job.clone(),
        cancel: cancellation.clone(),
        armed: true,
    };
    let result = async {
        let prepared = http
            .service
            .prepare_owned(body, family, local, Some(&owner), cancellation.clone())
            .await?;
        // Legacy routes retain their original filesystem input contract. Durable
        // TaskRuntime uses Service::submit and the real task.input hooks instead.
        inputs::protect_and_restore(
            &http.service.config,
            &prepared.originals,
            None,
            &cancellation,
        )
        .await?;
        let observation = Arc::new(LegacyObservation {
            job,
            cancel: cancellation,
        });
        let mut value = json!({"job":null});
        value["job"] = http
            .service
            .clone()
            .submit_protected(prepared, owner, Some(observation))
            .await?;
        Ok(value)
    }
    .await;
    if result.is_ok() {
        guard.armed = false;
    }
    response(result, StatusCode::ACCEPTED)
}

async fn guest_input(state: &AppState, service: &Service, body: &Value) -> Result<(String, Value)> {
    let key = body["requestKey"]
        .as_str()
        .filter(|key| uuid::Uuid::parse_str(key).is_ok())
        .ok_or_else(|| ApiError::invalid("请求编号无效"))?;
    let model = remote::muse::ANIMA;
    if body.get("modelId").is_some_and(|id| id != model) {
        return Err(ApiError::invalid("好友出图使用 MiaoMiao Anima 1.6"));
    }
    let scene = match body.get("scene") {
        Some(scene) => match (scene["kind"].as_str(), scene["id"].as_str()) {
            (Some(kind @ ("scene" | "blueprint")), Some(id)) => Some((kind.into(), id.into())),
            _ => return Err(ApiError::invalid("请选择有效的场景蓝图")),
        },
        None => None,
    };
    let character = body["characterId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 180);
    let description = body["prompt"].as_str().unwrap_or_default().trim();
    if description.encode_utf16().count() > 4000 {
        return Err(ApiError::invalid("画面描述最多 4000 字符"));
    }
    let mut input = if scene.is_some() || character.is_some() {
        let mut recipe =
            remote::muse::guest_recipe(state, service, scene, character.map(str::to_owned)).await?;
        if !description.is_empty() {
            recipe["prompt"] = json!(format!(
                "{}\n{description}",
                recipe["prompt"].as_str().unwrap_or_default()
            ));
        }
        recipe
    } else {
        if description.is_empty() {
            return Err(ApiError::invalid("请填写画面描述或选择角色"));
        }
        json!({"prompt":description,"modelId":model,"width":832,"height":1216})
    };
    input["teaCache"] = json!(true);
    Ok((key.to_owned(), input))
}
