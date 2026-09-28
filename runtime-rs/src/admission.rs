use crate::{AppState, host::OwnedWriteGuard};
use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use http_body::{Body as HttpBody, Frame, SizeHint};
use std::{
    pin::Pin,
    task::{Context, Poll},
};

/// Mirrors the existing host-wide write drain, including streamed POST chat and
/// audio. Keeping the guard in the body avoids ending admission at HTTP headers.
pub async fn track(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if matches!(request.uri().path(), "/api/desktop-host" | "/api/health") {
        return next.run(request).await;
    }
    if let Err(error) = state.host.check_available() {
        return error.into_response();
    }
    if matches!(request.method().as_str(), "GET" | "HEAD" | "OPTIONS") {
        return next.run(request).await;
    }
    let guard = match state.host.admit_owned() {
        Ok(guard) => guard,
        Err(error) => return error.into_response(),
    };
    next.run(request).await.map(|body| {
        Body::new(AdmittedBody {
            body,
            guard: Some(guard),
        })
    })
}

struct AdmittedBody {
    body: Body,
    guard: Option<OwnedWriteGuard>,
}
impl HttpBody for AdmittedBody {
    type Data = Bytes;
    type Error = axum::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let frame = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(frame, Poll::Ready(None | Some(Err(_)))) || self.body.is_end_stream() {
            self.guard.take();
        }
        frame
    }
    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}
