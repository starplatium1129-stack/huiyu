use super::{Live2dService, catalog, manifest};
use crate::error::{ApiError, Result};
use axum::body::Bytes;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub(super) struct Entry {
    pub bytes: Bytes,
    pub etag: String,
}
#[derive(Clone, Hash, PartialEq, Eq)]
struct Key {
    path: PathBuf,
    size: u64,
    modified: Option<std::time::SystemTime>,
    scale: i32,
}
struct Flight {
    done: Notify,
    result: Mutex<Option<std::result::Result<Entry, String>>>,
    listeners: AtomicUsize,
    cancel: CancellationToken,
}
struct Listener(Arc<Flight>);
impl Drop for Listener {
    fn drop(&mut self) {
        if self.0.listeners.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.cancel.cancel();
        }
    }
}
#[derive(Default)]
struct Cache {
    entries: VecDeque<(Key, Entry)>,
    bytes: usize,
    pending: HashMap<Key, Arc<Flight>>,
}
pub(super) struct Textures {
    cache: Mutex<Cache>,
    decode: Arc<Semaphore>,
}
impl Default for Textures {
    fn default() -> Self {
        Self {
            cache: Mutex::new(Cache::default()),
            decode: Arc::new(Semaphore::new(1)),
        }
    }
}
fn scale(quality: &str) -> Result<i32> {
    match quality {
        "standard" => Ok(2),
        "compact" => Ok(4),
        _ => Err(manifest::invalid("Invalid Live2D quality")),
    }
}
fn selected(snapshot: &catalog::Snapshot, character: &str) -> Result<(catalog::Model, Value)> {
    let model = snapshot
        .models
        .iter()
        .find(|model| model.id == character)
        .cloned()
        .ok_or_else(|| manifest::invalid("Unknown Live2D model"))?;
    let name = model
        .receipt
        .as_ref()
        .and_then(|receipt| receipt["manifest"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{character}.model3.json"));
    let document = manifest::read_json(&manifest::model_file(&model.directory, &name)?)?;
    Ok((model, document))
}
pub(super) fn projected(
    snapshot: &catalog::Snapshot,
    character: &str,
    quality: &str,
) -> Result<Value> {
    scale(quality)?;
    let (model, mut document) = selected(snapshot, character)?;
    let modern = manifest::format(&document)? == "cubism3";
    let textures = if modern {
        document["FileReferences"]["Textures"].clone()
    } else {
        document["textures"].clone()
    };
    let base = if model.receipt.is_some() {
        "/api/live2d-local/"
    } else {
        "/assets/live2d-current/"
    };
    manifest::map_references(&mut document, |reference| {
        manifest::model_file(&model.directory, reference)?;
        let mut url = url::Url::parse(&format!("http://localhost{base}{character}/")).unwrap();
        {
            let mut path = url.path_segments_mut().unwrap();
            path.pop_if_empty();
            for part in reference.replace('\\', "/").split('/') {
                path.push(part);
            }
        }
        Ok(url.path().into())
    })?;
    let urls = Value::Array(
        textures
            .as_array()
            .ok_or_else(|| manifest::invalid("Invalid textures"))?
            .iter()
            .enumerate()
            .map(|(index, _)| {
                Value::String(format!(
                    "/api/live2d-texture/{character}/{quality}/{index}.webp"
                ))
            })
            .collect(),
    );
    if modern {
        document["FileReferences"]["Textures"] = urls;
    } else {
        document["textures"] = urls;
    }
    Ok(document)
}
impl Textures {
    pub async fn get(
        self: &Arc<Self>,
        service: &Live2dService,
        character: String,
        quality: String,
        index: usize,
    ) -> Result<Entry> {
        let scale = scale(&quality)?;
        let key = service
            .run(move |service, cancel| {
                let snapshot = service
                    .catalog
                    .read(&service.builtins, &service.local, cancel)?;
                let (model, document) = selected(&snapshot, &character)?;
                let textures = if manifest::format(&document)? == "cubism3" {
                    &document["FileReferences"]["Textures"]
                } else {
                    &document["textures"]
                };
                let reference = textures[index]
                    .as_str()
                    .ok_or_else(|| manifest::invalid("Invalid texture index"))?;
                let path = manifest::model_file(&model.directory, reference)?;
                let meta = std::fs::metadata(&path)?;
                Ok(Key {
                    path,
                    size: meta.len(),
                    modified: meta.modified().ok(),
                    scale,
                })
            })
            .await?;
        let (flight, start) = {
            let mut cache = self.cache.lock().unwrap();
            if let Some(index) = cache
                .entries
                .iter()
                .position(|(candidate, _)| candidate == &key)
            {
                let entry = cache.entries.remove(index).unwrap();
                let result = entry.1.clone();
                cache.entries.push_back(entry);
                return Ok(result);
            }
            if let Some(flight) = cache.pending.get(&key).filter(|flight| {
                !flight.cancel.is_cancelled()
                    && flight
                        .listeners
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                            if count > 0 {
                                count.checked_add(1)
                            } else {
                                None
                            }
                        })
                        .is_ok()
            }) {
                (flight.clone(), false)
            } else {
                let flight = Arc::new(Flight {
                    done: Notify::new(),
                    result: Mutex::new(None),
                    listeners: AtomicUsize::new(1),
                    cancel: service.shutdown.child_token(),
                });
                cache.pending.insert(key.clone(), flight.clone());
                (flight, true)
            }
        };
        let _listener = Listener(flight.clone());
        if start {
            let owned = self.clone();
            let work = flight.clone();
            let library = service.native_library.clone();
            tokio::spawn(async move {
                let result=async{
                    let permit=tokio::select!{permit=owned.decode.clone().acquire_owned()=>permit.map_err(|_|"Texture decoder closed")?,_=work.cancel.cancelled()=>return Err("Texture request cancelled".into())};
                    let path=key.path.clone();let cancel=work.cancel.clone();let scale=key.scale;
                    tokio::task::spawn_blocking(move||{let _permit=permit;crate::native_images::atlas(&path,&library,scale,&cancel)})
                        .await.map_err(|_|"Texture decoder failed".to_owned())?.map(|bytes|Entry{etag:format!("\"{:x}\"",Sha256::digest(&bytes)),bytes:Bytes::from(bytes)})
                }.await;
                let mut cache = owned.cache.lock().unwrap();
                if let Ok(entry) = &result
                    && entry.bytes.len() <= 32 * 1024 * 1024
                    && !work.cancel.is_cancelled()
                {
                    cache.bytes += entry.bytes.len();
                    cache.entries.push_back((key.clone(), entry.clone()));
                    while cache.bytes > 32 * 1024 * 1024 {
                        let (_, evicted) = cache.entries.pop_front().unwrap();
                        cache.bytes -= evicted.bytes.len();
                    }
                }
                if cache
                    .pending
                    .get(&key)
                    .is_some_and(|entry| Arc::ptr_eq(entry, &work))
                {
                    cache.pending.remove(&key);
                }
                *work.result.lock().unwrap() = Some(result);
                work.done.notify_waiters();
            });
        }
        let waiting = async {
            loop {
                let notified = flight.done.notified();
                if let Some(result) = flight.result.lock().unwrap().as_ref() {
                    return result
                        .clone()
                        .map_err(|error| ApiError::new(422, "LIVE2D_TEXTURE_FAILED", error));
                }
                notified.await;
            }
        };
        tokio::select! {
            result=tokio::time::timeout(Duration::from_secs(60),waiting)=>result.map_err(|_|ApiError::new(504,"LIVE2D_TIMEOUT","Texture preparation timed out"))?,
            _=service.shutdown.cancelled()=>Err(ApiError::new(503,"LIVE2D_CLOSED","Live2D service closed")),
        }
    }
}
