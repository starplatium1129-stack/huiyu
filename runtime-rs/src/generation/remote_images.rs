//! Durable history and completed files for the desktop's authenticated image listener.
use super::*;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek},
    path::{Path, PathBuf},
};

const RESULT_TTL: i64 = 48 * 60 * 60 * 1000;
const HISTORY_TTL: i64 = 7 * 24 * 60 * 60 * 1000;
const RESULT_BUDGET: i64 = 2 * 1024 * 1024 * 1024;

pub(crate) struct Store {
    root: PathBuf,
    ready: std::sync::Mutex<bool>,
    pub(crate) owner: String,
    epoch: String,
    pub(crate) published: tokio::sync::Notify,
}

impl Store {
    pub(super) fn new(root: PathBuf, key: &str) -> Self {
        Self {
            root,
            ready: std::sync::Mutex::new(false),
            owner: hex::encode(Sha256::digest(key.as_bytes())),
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            published: tokio::sync::Notify::new(),
        }
    }

    pub(crate) async fn work<T: Send + 'static>(
        self: &Arc<Self>,
        work: impl FnOnce(&mut Connection, &Self) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || work(&mut store.open()?, &store))
            .await
            .map_err(|_| unavailable())?
    }

    fn open(&self) -> Result<Connection> {
        let directory = self.root.join("jobs");
        fs::create_dir_all(&directory)?;
        ensure_directory(&directory)?;
        let path = directory.join("remote-images.sqlite");
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err(unavailable());
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(3))?;
        let mut ready = self.ready.lock().unwrap();
        if !*ready {
            db.execute_batch("PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS image_jobs (
                    id TEXT PRIMARY KEY, owner TEXT NOT NULL, epoch TEXT NOT NULL,
                    family TEXT NOT NULL, model TEXT NOT NULL, seed INTEGER NOT NULL,
                    created INTEGER NOT NULL, finished INTEGER, duration INTEGER,
                    status TEXT NOT NULL, error TEXT, code TEXT, bytes INTEGER, digest TEXT, metadata TEXT NOT NULL
                ) STRICT;
                CREATE INDEX IF NOT EXISTS image_jobs_recent ON image_jobs(owner,created DESC,id DESC);
                CREATE INDEX IF NOT EXISTS image_jobs_stats ON image_jobs(finished DESC) WHERE duration IS NOT NULL;
                CREATE INDEX IF NOT EXISTS image_jobs_results ON image_jobs(finished DESC,id) WHERE bytes IS NOT NULL;
                CREATE TABLE IF NOT EXISTS muse_batches (
                    owner TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, created INTEGER NOT NULL,
                    PRIMARY KEY(owner,key)
                ) WITHOUT ROWID, STRICT;
                CREATE TABLE IF NOT EXISTS muse_items (
                    pos INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, batch TEXT NOT NULL,
                    request TEXT NOT NULL, family TEXT NOT NULL, kind TEXT NOT NULL, scene TEXT NOT NULL,
                    model TEXT NOT NULL, seed INTEGER NOT NULL, variant INTEGER NOT NULL, payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'waiting', job TEXT, error TEXT, code TEXT,
                    UNIQUE(owner,request)
                ) STRICT;
                CREATE INDEX IF NOT EXISTS muse_items_waiting ON muse_items(owner,pos) WHERE status='waiting';
                CREATE INDEX IF NOT EXISTS muse_items_batch ON muse_items(owner,batch,pos);
                CREATE INDEX IF NOT EXISTS muse_batches_recent ON muse_batches(owner,created DESC,key DESC);
                CREATE INDEX IF NOT EXISTS muse_items_job ON muse_items(owner,job) WHERE job IS NOT NULL;")?;
            *ready = true;
        }
        Ok(db)
    }

    fn result_path(&self, id: &str) -> PathBuf {
        self.root
            .join("outputs/anima/muse-archive")
            .join(format!("{id}.png"))
    }

    pub(super) async fn register(self: &Arc<Self>, job: &Job) -> Result<()> {
        let id = job.id.clone();
        let (family, model, seed, created) = (
            job.input["family"].as_str().unwrap_or("anima").to_owned(),
            job.input["modelId"].as_str().unwrap_or_default().to_owned(),
            job.input["seed"].as_i64().unwrap_or(0),
            job.created,
        );
        let metadata =
            json!({"modelId":model,"family":family,"seed":seed,"width":job.input["width"],
            "height":job.input["height"],"steps":job.input["steps"],"cfg":job.input["cfg"]})
            .to_string();
        self.work(move |db, store| {
            db.execute(
                "INSERT INTO image_jobs(id,owner,epoch,family,model,seed,created,status,metadata)
                        VALUES (?1,?2,?3,?4,?5,?6,?7,'queued',?8)",
                params![
                    id,
                    store.owner,
                    store.epoch,
                    family,
                    model,
                    seed,
                    created,
                    metadata
                ],
            )?;
            Ok(())
        })
        .await
    }

    pub(super) async fn finish(
        self: &Arc<Self>,
        job: &Job,
        status: &str,
        error: Option<&str>,
        code: Option<&str>,
    ) {
        let (id, status, error, code) = (
            job.id.clone(),
            status.to_owned(),
            error.map(str::to_owned),
            code.map(str::to_owned),
        );
        if let Err(error) = self
            .work(move |db, store| {
                db.execute(
                    "UPDATE image_jobs SET status=?1,finished=?2,error=?3,code=?4
                        WHERE id=?5 AND owner=?6 AND bytes IS NULL",
                    params![status, now(), error, code, id, store.owner],
                )?;
                Ok(())
            })
            .await
        {
            eprintln!("remote image history: {}", error.code);
        }
    }

    pub(super) async fn publish(self: &Arc<Self>, job: &Job, output: &Output) -> Result<String> {
        let Output::File { path, bytes, .. } = output else {
            return Err(unavailable());
        };
        let (id, source, bytes) = (job.id.clone(), path.clone(), *bytes);
        let started = job.started_at.load(Ordering::Relaxed);
        self.work(move |db, store| {
            let target = store.result_path(&id);
            let directory = target.parent().unwrap();
            fs::create_dir_all(directory)?;
            ensure_directory(directory)?;
            let mut file = std::fs::File::open(&source)?;
            let mut digest = Sha256::new();
            if std::io::copy(&mut Read::by_ref(&mut file).take(bytes + 1), &mut digest)? != bytes {
                return Err(unavailable());
            }
            let digest = hex::encode(digest.finalize());
            if fs::hard_link(&source, &target).is_err() {
                let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
                file.rewind()?;
                if std::io::copy(&mut file.take(bytes + 1), &mut temporary)? != bytes {
                    return Err(unavailable());
                }
                temporary.as_file().sync_all()?;
                temporary
                    .persist_noclobber(&target)
                    .map_err(|error| error.error)?;
            }
            let finished = now();
            let duration = (started > 0).then_some((finished - started).max(1));
            let saved = db.execute(
                "UPDATE image_jobs SET status='succeeded',finished=?1,duration=?2,
                        bytes=?3,digest=?4 WHERE id=?5 AND owner=?6 AND epoch=?7",
                params![
                    finished,
                    duration,
                    bytes as i64,
                    digest,
                    id,
                    store.owner,
                    store.epoch
                ],
            );
            match saved {
                Ok(1) => {
                    store.published.notify_one();
                    Ok(digest)
                }
                result => {
                    let _ = fs::remove_file(target);
                    result?;
                    Err(unavailable())
                }
            }
        })
        .await
    }

    pub(crate) async fn recent(
        self: &Arc<Self>,
        since: i64,
        before: Option<(i64, String)>,
        limit: u32,
    ) -> Result<Vec<Value>> {
        self.work(move |db, store| {
            let (time, id) = before.unwrap_or((i64::MAX, String::new()));
            let mut statement = db.prepare(&format!("SELECT * FROM (
                SELECT {COLUMNS}, 'job' AS entry, 'job:'||id AS sort_id FROM image_jobs WHERE owner=?1 AND created>=?2
                UNION ALL
                SELECT key,'','','',0,created,NULL,'',NULL,NULL,NULL,NULL,'{{}}',NULL,'batch','batch:'||key
                FROM muse_batches WHERE owner=?1 AND created>=?2
            ) WHERE (created,sort_id)<(?3,?4) ORDER BY created DESC,sort_id DESC LIMIT ?5"))?;
            let rows = statement.query_map(params![store.owner, since, time, id, limit], |row| {
                if row.get_ref("entry")?.as_str()? == "batch" {
                    let key: String = row.get(0)?;
                    let path = format!("/api/muse/batches/{key}");
                    let (count, active, done, failed, cancelled): (i64,i64,i64,i64,i64) = db.query_row(
                        "SELECT count(*),coalesce(sum(state IN ('waiting','queued','running','cancelling')),0),
                            coalesce(sum(state='succeeded'),0),coalesce(sum(state IN ('failed','interrupted')),0),coalesce(sum(state='cancelled'),0)
                         FROM (SELECT CASE WHEN i.status<>'assigned' THEN i.status
                            WHEN j.finished IS NULL AND j.epoch<>?3 THEN 'interrupted' ELSE coalesce(j.status,'interrupted') END AS state
                         FROM muse_items i LEFT JOIN image_jobs j ON j.id=i.job AND j.owner=i.owner WHERE i.owner=?1 AND i.batch=?2)",
                        params![store.owner,key,store.epoch], |counts| Ok((counts.get(0)?,counts.get(1)?,counts.get(2)?,counts.get(3)?,counts.get(4)?)))?;
                    let status = if active > 0 { "queued" } else if count == done { "succeeded" }
                        else if count == failed { "failed" } else if count == cancelled { "cancelled" } else { "completed" };
                    Ok(json!({"entryType":"batch","id":key,"requestKey":key,"batchKey":key,"status":status,"createdAt":row.get::<_,i64>(5)?,
                        "itemCount":count,"activeCount":active,"succeededCount":done,"failedCount":failed,"cancelledCount":cancelled,"statusPath":path,"cancelPath":path}))
                } else {
                    let mut job = row_value(row, store)?;
                    let id: &str = row.get_ref(0)?.as_str()?;
                    let batch: Option<String> = db.query_row("SELECT batch FROM muse_items WHERE owner=?1 AND job=?2 LIMIT 1",
                        params![store.owner,id], |r| r.get(0)).optional()?;
                    job["entryType"] = json!("image");
                    job["batchKey"] = json!(batch);
                    Ok(job)
                }
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .await
    }

    pub(super) async fn get(self: &Arc<Self>, id: &str, family: &str) -> Result<Option<Value>> {
        let (id, family) = (id.to_owned(), family.to_owned());
        self.work(move |db, store| {
            Ok(db
                .query_row(
                    &format!(
                        "SELECT {COLUMNS} FROM image_jobs WHERE id=?1 AND family=?2 AND owner=?3"
                    ),
                    params![id, family, store.owner],
                    |row| row_value(row, store),
                )
                .optional()?)
        })
        .await
    }

    pub(super) async fn result(self: &Arc<Self>, id: &str, family: &str) -> Result<Option<Output>> {
        let Some(job) = self.get(id, family).await? else {
            return Ok(None);
        };
        let bytes = job["resultBytes"]
            .as_u64()
            .ok_or_else(|| ApiError::new(410, "RESULT_EXPIRED", "原图已过期或任务未留下成品"))?;
        let path = self.result_path(id);
        if !tokio::fs::symlink_metadata(&path)
            .await
            .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && m.len() == bytes)
        {
            return Err(ApiError::new(
                410,
                "RESULT_EXPIRED",
                "原图已过期或文件不可用",
            ));
        }
        Ok(Some(Output::File {
            path,
            mime: "image/png".into(),
            bytes,
        }))
    }

    pub(crate) async fn timings(self: &Arc<Self>) -> Result<HashMap<String, f64>> {
        self.work(|db, _| {
            let mut statement = db.prepare("SELECT model,avg(duration) FROM (
                SELECT model,duration FROM image_jobs WHERE duration IS NOT NULL ORDER BY finished DESC LIMIT 128
            ) GROUP BY model")?;
            let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get::<_, f64>(1)? / 1000.)))?;
            Ok(rows.collect::<rusqlite::Result<_>>()?)
        }).await
    }

    pub(super) async fn prune(self: &Arc<Self>) {
        if let Err(error) = self.work(|db, store| {
            let cutoff = now();
            let mut statement = db.prepare("SELECT id,bytes,finished FROM image_jobs WHERE bytes IS NOT NULL ORDER BY finished DESC,id")?;
            let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))?;
            let mut total = 0;
            let mut expired = Vec::new();
            for row in rows {
                let (id, bytes, finished) = row?;
                total += bytes;
                if total > RESULT_BUDGET || finished < cutoff - RESULT_TTL {
                    expired.push(id);
                }
            }
            drop(statement);
            let tx = db.transaction()?;
            for id in &expired {
                match fs::remove_file(store.result_path(id)) {
                    Ok(()) => {},
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                    Err(_) => continue,
                }
                tx.execute("UPDATE image_jobs SET bytes=NULL,digest=NULL WHERE id=?", [id])?;
            }
            tx.execute("DELETE FROM image_jobs WHERE created<?1 AND bytes IS NULL
                        AND (finished IS NOT NULL OR epoch<>?2)", params![cutoff - HISTORY_TTL, store.epoch])?;
            tx.execute("DELETE FROM muse_batches AS b WHERE created<?1 AND NOT EXISTS (
                SELECT 1 FROM muse_items AS i WHERE i.owner=b.owner AND i.batch=b.key AND i.status='waiting')", [cutoff - HISTORY_TTL])?;
            tx.execute("DELETE FROM muse_items AS i WHERE NOT EXISTS (
                SELECT 1 FROM muse_batches AS b WHERE b.owner=i.owner AND b.key=i.batch)", [])?;
            tx.commit()?;
            Ok(())
        }).await {
            eprintln!("remote image pruning: {}", error.code);
        }
    }
}

const COLUMNS: &str =
    "id,epoch,family,model,seed,created,finished,status,error,code,bytes,digest,metadata,duration";
const FAMILIES: &[(&str, &str)] = &[
    ("anima", "anima"),
    ("krea2", "creative"),
    ("qwen-image", "qwen"),
    ("moss-image", "moss"),
    ("keyframe", "keyframe"),
    ("manga-screen", "manga"),
];

pub(crate) fn image_route(family: &str) -> Option<&'static str> {
    FAMILIES
        .iter()
        .find(|(value, _)| *value == family)
        .map(|(_, route)| *route)
}

fn row_value(row: &rusqlite::Row<'_>, store: &Store) -> rusqlite::Result<Value> {
    let id: String = row.get(0)?;
    let epoch: String = row.get(1)?;
    let family: String = row.get(2)?;
    let mut status: String = row.get(7)?;
    let mut error: Option<String> = row.get(8)?;
    let mut code: Option<String> = row.get(9)?;
    let finished: Option<i64> = row.get(6)?;
    if status == "interrupted" || (epoch != store.epoch && finished.is_none()) {
        status = "failed".into();
        error = Some("绘遇重启中断了任务，请确认后重新出图".into());
        code = Some("JOB_INTERRUPTED".into());
    }
    let retained = finished.is_some_and(|at| at + RESULT_TTL > now());
    let bytes = row
        .get::<_, Option<i64>>(10)?
        .filter(|_| retained)
        .and_then(|value| u64::try_from(value).ok());
    let digest = row
        .get::<_, Option<String>>(11)?
        .filter(|_| bytes.is_some());
    let path = format!("/api/{}/jobs/{id}", image_route(&family).unwrap_or("anima"));
    let url = bytes.map(|_| format!("{path}/result"));
    let mut metadata: Value =
        serde_json::from_str(row.get_ref(12)?.as_str()?).unwrap_or_else(|_| json!({}));
    metadata["resultUrl"] = json!(url);
    let unknown = code.as_deref() == Some("TERMINATION_UNCONFIRMED") && epoch == store.epoch;
    Ok(
        json!({"id":id,"family":family,"provider":"native","modelId":row.get::<_,String>(3)?, "seed":row.get::<_,i64>(4)?,
        "createdAt":row.get::<_,i64>(5)?,"finishedAt":finished,"generationMs":row.get::<_,Option<i64>>("duration")?,"status":status,"error":error,"code":code,
        "metadata":metadata,"upstreamSettled":terminal(&status)&&!unknown,"unknown":unknown,
        "statusPath":path,"cancelPath":path,"resultAvailable":bytes.is_some(),
        "resultUrl":url,"resultBytes":bytes,"resultSha256":digest,
        "resultExpiresAt":bytes.and(finished).map(|at| at + RESULT_TTL)}),
    )
}

fn ensure_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(unavailable());
    }
    Ok(())
}

fn unavailable() -> ApiError {
    ApiError::new(
        503,
        "REMOTE_IMAGE_HISTORY_UNAVAILABLE",
        "远程成品或任务记录暂时不可用",
    )
}

impl Service {
    pub(crate) async fn remote_queue(&self, owner: &str) -> Result<(Value, HashMap<String, f64>)> {
        let store = self
            .remote_store()
            .filter(|store| store.owner == owner)
            .ok_or_else(unavailable)?;
        let timings = store.timings().await?;
        let order = self.inner.native.queue_order();
        let queued_jobs: Vec<_> = {
            let state = self.inner.state.lock().await;
            order.iter().map(|id| state.jobs.get(id).cloned()).collect()
        };
        let mut items = Vec::new();
        let mut ahead = 0;
        let mut seconds = Some(0.0_f64);
        let mut running = 0;
        let mut queued = 0;
        for job in queued_jobs {
            let Some(job) = job else {
                // A different media service may own this GPU slot.
                ahead += 1;
                seconds = None;
                continue;
            };
            let started = job.started_at.load(Ordering::Relaxed);
            let state = job.state.lock().await;
            if terminal(&state.status) {
                continue;
            }
            let model = job.input["modelId"].as_str().unwrap_or_default();
            let mut runtime = timings.get(model).copied();
            if started > 0 {
                running += 1;
                let elapsed = (now() - started).max(0) as f64 / 1000.;
                runtime = match state
                    .progress
                    .filter(|progress| (0.1..1.0).contains(progress))
                {
                    Some(progress) => Some((elapsed * (1. - progress) / progress).max(1.)),
                    None => runtime.map(|duration| (duration - elapsed).max(1.)),
                };
            } else {
                queued += 1;
            }
            let completion = seconds.zip(runtime).map(|(wait, run)| wait + run);
            if job.owner == owner {
                let id = &job.id;
                let path = format!("{}/jobs/{id}", job.execution.route_base());
                items.push(json!({"id":id,"status":state.status,"modelId":model,"seed":job.input["seed"],"createdAt":job.created,
                    "queuePosition":if started>0 {0} else {ahead+1},"ahead":ahead,
                    "progress":state.progress,"progressText":state.progress_text,
                    "estimatedStartSeconds":if started>0 {Some(0)} else {seconds.map(|s| s.ceil() as u64)},
                    "estimatedFinishSeconds":completion.map(|s| s.ceil() as u64),"statusPath":path,"cancelPath":path}));
            }
            seconds = completion;
            ahead += 1;
        }
        Ok((
            json!({"items":items,"gpuRunning":running,"gpuQueued":queued,"gpuAhead":ahead,"estimatedAvailableSeconds":seconds}),
            timings,
        ))
    }
}
