use crate::{AppState, error::ApiError};
use axum::{
    Json,
    body::Bytes,
    extract::{
        FromRequest, Request,
        rejection::{JsonRejection, MissingJsonContentType},
    },
    http::header,
    response::{IntoResponse, Response},
};
use serde_json::Value;
use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

static UPLOADS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

pub(crate) struct UploadBody(pub Value, pub OwnedSemaphorePermit);
pub(crate) struct RawUploadBody(pub Bytes, pub OwnedSemaphorePermit);

impl FromRequest<AppState> for UploadBody {
    type Rejection = Response;

    async fn from_request(request: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        // Keep Axum Json's MIME check before body collection, including +json
        // and its original MissingJsonContentType/BytesRejection responses.
        let json = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<mime::Mime>().ok())
            .is_some_and(|value| {
                value.type_() == mime::APPLICATION
                    && (value.subtype() == mime::JSON || value.suffix() == Some(mime::JSON))
            });
        if !json {
            return Err(MissingJsonContentType::default().into_response());
        }
        let scope = state.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let (bytes, permit) = collect(request, state, &scope).await?;
        // CPU work owns both the body and admission after caller cancellation;
        // the handler then transfers admission to the tracked save worker.
        tokio::task::spawn_blocking(move || {
            if scope.is_cancelled() {
                return Err(cancelled());
            }
            let Json(body) =
                Json::<Value>::from_bytes(&bytes).map_err(IntoResponse::into_response)?;
            drop(bytes);
            if scope.is_cancelled() {
                return Err(cancelled());
            }
            Ok(Self(body, permit))
        })
        .await
        .map_err(|_| {
            ApiError::new(503, "IMAGE_PARSE_FAILED", "图片请求解析未完成").into_response()
        })?
    }
}

impl FromRequest<AppState> for RawUploadBody {
    type Rejection = Response;

    async fn from_request(request: Request, state: &AppState) -> Result<Self, Self::Rejection> {
        let raw = request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<mime::Mime>().ok())
            .is_some_and(|value| value.essence_str() == "application/octet-stream");
        if !raw {
            return Err(
                ApiError::new(415, "INVALID_IMAGE_BODY", "请求体必须是图片二进制数据")
                    .into_response(),
            );
        }
        let scope = state.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let (bytes, permit) = collect(request, state, &scope).await?;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        Ok(Self(bytes, permit))
    }
}

async fn collect(
    request: Request,
    state: &AppState,
    scope: &CancellationToken,
) -> Result<(Bytes, OwnedSemaphorePermit), Response> {
    // Raw and JSON uploads share admission before collecting any full body.
    // Preserve each route's DefaultBodyLimit extensions on the original request.
    let permit = admit(scope).await.map_err(IntoResponse::into_response)?;
    let bytes = tokio::select! {
        biased;
        _ = scope.cancelled() => return Err(cancelled()),
        bytes = tokio::time::timeout(Duration::from_secs(60), Bytes::from_request(request, state)) => {
            bytes.map_err(|_| ApiError::new(408, "IMAGE_UPLOAD_TIMEOUT", "图片上传超时，请重试").into_response())?
                .map_err(|error| JsonRejection::from(error).into_response())?
        },
    };
    Ok((bytes, permit))
}

pub(crate) async fn admit(scope: &CancellationToken) -> crate::error::Result<OwnedSemaphorePermit> {
    tokio::select! {
        biased;
        _ = scope.cancelled() => Err(ApiError::new(499, "CANCELLED", "图像操作已取消")),
        permit = tokio::time::timeout(Duration::from_secs(30), UPLOADS.clone().acquire_owned()) => {
            permit.map_err(|_| ApiError::new(503, "IMAGE_UPLOAD_BUSY", "图片上传繁忙，请稍后再试"))?
                .map_err(|_| ApiError::new(499, "CANCELLED", "图像操作已取消"))
        },
    }
}

fn cancelled() -> Response {
    ApiError::new(499, "CANCELLED", "图像操作已取消").into_response()
}
