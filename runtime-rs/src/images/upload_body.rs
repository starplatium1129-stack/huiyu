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
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

static PARSERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

pub(crate) struct UploadBody(pub Value);

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
        let bytes = Bytes::from_request(request, state)
            .await
            .map_err(|error| JsonRejection::from(error).into_response())?;
        let scope = state.shutdown.child_token();
        let _guard = scope.clone().drop_guard();
        let permit = tokio::select! {
            biased;
            _ = scope.cancelled() => return Err(cancelled()),
            permit = PARSERS.clone().acquire_owned() => permit.map_err(|_| cancelled())?,
        };
        // CPU work owns both the body and admission after caller cancellation;
        // dropping the awaiting JoinHandle cannot release its slot early.
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            if scope.is_cancelled() {
                return Err(cancelled());
            }
            let Json(body) =
                Json::<Value>::from_bytes(&bytes).map_err(IntoResponse::into_response)?;
            drop(bytes);
            if scope.is_cancelled() {
                return Err(cancelled());
            }
            Ok(Self(body))
        })
        .await
        .map_err(|_| {
            ApiError::new(503, "IMAGE_PARSE_FAILED", "图片请求解析未完成").into_response()
        })?
    }
}

fn cancelled() -> Response {
    ApiError::new(499, "CANCELLED", "图像操作已取消").into_response()
}
