use super::*;
use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::{Method, StatusCode},
};
use futures_util::StreamExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug)]
pub(super) enum Asset {
    Published(Vec<u8>, String),
    Legacy(PathBuf),
    Missing,
}
struct Published {
    bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
}
impl AsRef<[u8]> for Published {
    fn as_ref(&self) -> &[u8] {
        &self.bytes
    }
}
impl Reader {
    pub(super) fn asset(&mut self, relative: &str) -> Result<Asset> {
        if self.blocked {
            return Err(invalid_release());
        }
        if let Some(release) = &self.release {
            return match release.image(&self.app_root, relative) {
                Ok(Some((bytes, hash))) => Ok(Asset::Published(bytes, hash)),
                Ok(None) => Ok(Asset::Missing),
                Err(_) => {
                    self.blocked = true;
                    Err(invalid_release())
                }
            };
        }
        let Some(root) = &self.reference_root else {
            return Ok(Asset::Missing);
        };
        let file = root.join(relative);
        io::no_links(&file)?;
        let (Ok(base), Ok(target)) = (root.canonicalize(), file.canonicalize()) else {
            return Ok(Asset::Missing);
        };
        Ok(
            if target.starts_with(&base) && target != base && target.is_file() {
                Asset::Legacy(target)
            } else {
                Asset::Missing
            },
        )
    }
}
pub(super) async fn serve(
    State(state): State<AppState>,
    Extension(readers): Extension<ReaderState>,
    Extension(slots): Extension<Arc<Semaphore>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(relative): Path<String>,
    request: Request,
) -> Response {
    let result=async {
        if !security::is_direct_local(request.headers(),peer.ip()) {return Err(ApiError::new(403,"REFERENCE_LOCAL_ONLY","该参考资源仅限本机使用"));}
        if relative.contains(['\\','\0',':'])||relative.split('/').any(|part|part.is_empty()||part.starts_with('.')){return Ok(StatusCode::NOT_FOUND.into_response());}
        let permit=tokio::select! {permit=slots.acquire_owned()=>permit.map_err(|_|unavailable())?,_=state.shutdown.cancelled()=>return Err(unavailable())};
        let target=relative.clone();
        let asset=with_reader(readers,state.config.content_root(),state.config.app_root.clone(),&state.shutdown,move|reader|{
            Ok::<_,ApiError>((reader.asset(&target)?,permit))
        }).await?;
        let response=match asset {
            (Asset::Missing,_)=>StatusCode::NOT_FOUND.into_response(),
            (Asset::Legacy(path),_)=>{
                let mut service=tower_http::services::ServeFile::new(path);
                service.try_call(request).await.map_err(|_|unavailable())?.map(|body|Body::from_stream(Body::new(body).into_data_stream().take_until(state.shutdown.cancelled_owned())))
            }
            (Asset::Published(bytes,hash),permit)=>{
                let etag=format!("\"{hash}\"");
                let fresh=request.headers().get("if-none-match").and_then(|h|h.to_str().ok()).is_some_and(|v|v.split(',').any(|tag|matches!(tag.trim(),"*")||tag.trim().trim_start_matches("W/")==etag));
                let length=bytes.len();
                let mut response=if fresh{StatusCode::NOT_MODIFIED.into_response()}else if request.method()==Method::HEAD{Body::empty().into_response()}else{Bytes::from_owner(Published{bytes,_permit:permit}).into_response()};
                response.headers_mut().insert("etag",etag.parse().unwrap());
                if !fresh {response.headers_mut().insert("content-length",length.to_string().parse().unwrap());response.headers_mut().insert("content-type",mime(&relative).parse().unwrap());}
                response
            }
        };
        Ok(response)
    }.await;
    let mut response = result.unwrap_or_else(IntoResponse::into_response);
    response
        .headers_mut()
        .insert("cache-control", "private, no-cache".parse().unwrap());
    response
}
fn mime(relative: &str) -> &'static str {
    match relative
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}
