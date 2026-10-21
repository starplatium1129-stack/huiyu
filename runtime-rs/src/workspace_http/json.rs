use super::*;
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

const BLOCKING_THRESHOLD: usize = 512 * 1024;
static WORKERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

pub(super) enum Request {
    Capability(Value),
    Command(Value),
    Chunk(Value, Bytes),
}

pub(super) async fn prepare(
    body: Bytes,
    method: Method,
    path: Vec<String>,
    query: Query,
    capability: bool,
    workspace_id: String,
    content_type: &str,
) -> Result<Request> {
    if method == Method::PUT
        && path.len() == 3
        && path[2] == "chunks"
        && matches!(path[0].as_str(), "artwork-saves" | "media-uploads")
    {
        if content_type != "application/octet-stream"
            || body.is_empty()
            || body.len() > 1024 * 1024
        {
            return Err(ApiError::invalid("Expected a nonempty binary chunk of at most 1 MiB"));
        }
        return Ok(Request::Chunk(commands::binary_chunk(&path, &query, &workspace_id)?, body));
    }
    let size = body.len();
    let build = move || {
        let mut input: Value = if body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&body)?
        };
        drop(body);
        if capability {
            return Ok(Request::Capability(input));
        }
        if !matches!(method, Method::GET | Method::HEAD) {
            if input["protocolVersion"] != 1 {
                return Err(ApiError::new(
                    409,
                    "PROTOCOL_VERSION",
                    "Workspace protocol version does not match",
                ));
            }
            if input["workspaceId"].as_str() != Some(workspace_id.as_str()) {
                return Err(ApiError::new(
                    409,
                    "WORKSPACE_IDENTITY",
                    "Workspace identity does not match",
                ));
            }
        }
        // The actor owns only the validated command. Neither the raw HTTP body
        // nor the second decoded input tree survives its potentially long wait.
        command(&method, &path, &query, &mut input).map(Request::Command)
    };
    if size < BLOCKING_THRESHOLD {
        build()
    } else {
        blocking(build).await
    }
}

pub(super) async fn encode(envelope: Value) -> Result<Response> {
    blocking(move || Ok(Json(envelope).into_response())).await
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(30), async {
        let permit = WORKERS
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| unavailable())?;
        // A cancelled HTTP waiter drops its queue position; an already running
        // CPU job retains its owned buffers and slot until actual completion.
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work()
        })
        .await
        .map_err(|_| unavailable())?
    })
    .await
    .map_err(|_| {
        ApiError::new(
            504,
            "WORKSPACE_TIMEOUT",
            "Workspace JSON processing timed out",
        )
    })?
}

fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "WORKSPACE_UNAVAILABLE",
        "Workspace JSON processing unavailable",
    )
}
