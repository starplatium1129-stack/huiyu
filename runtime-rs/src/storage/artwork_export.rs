use super::*;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

const ELIGIBLE: &str = "deleted_at IS NULL AND json_type(body,'$.image_id')='text' AND json_extract(body,'$.image_id')!=''";
pub(super) fn page(c: &Context, command: &Value) -> Result<Value> {
    let revision = artwork_index::revision(c)?;
    if command
        .get("revision")
        .is_some_and(|value| value.as_i64() != Some(revision))
    {
        return Err(conflict(
            "ARTWORK_EXPORT_CHANGED",
            "作品库在导出期间发生变更，请重新导出；已保存文件保留",
        ));
    }
    let cursor = command
        .get("cursor")
        .map(|_| string(command, "cursor"))
        .transpose()?;
    let total: Option<i64> = if cursor.is_none() {
        Some(c.db.query_row(
            &format!("SELECT count(*) FROM artworks WHERE {ELIGIBLE}"),
            [],
            |r| r.get(0),
        )?)
    } else {
        None
    };
    let sql = format!(
        "SELECT id_key,id_json,json_extract(body,'$.image_id'),json_extract(body,'$.title'),body -> '$.timestamp' FROM artworks WHERE {ELIGIBLE} AND (?1 IS NULL OR id_key>?1) ORDER BY id_key LIMIT 65"
    );
    let mut stmt = c.db.prepare_cached(&sql)?;
    let mut rows = stmt.query(params![cursor])?;
    let mut items: Vec<Value> = Vec::new();
    let mut next = Value::Null;
    while let Some(row) = rows.next()? {
        c.check_cancel()?;
        if items.len() == 64 {
            next = items.last().unwrap()["key"].clone();
            break;
        }
        items.push(json!({"key":row.get::<_,String>(0)?,"id":records::json_column(row,1)?,"imageId":row.get::<_,String>(2)?,
            "title":row.get::<_,Option<String>>(3)?.unwrap_or_default(),"timestamp":row.get::<_,Option<String>>(4)?.map(|v|serde_json::from_str::<Value>(&v)).transpose()?}));
    }
    Ok(json!({"items":items,"nextCursor":next,"revision":revision,"total":total}))
}

fn filename(index: u64, row: &Value, mime: &str) -> Result<String> {
    let extension = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/svg+xml" => "svg",
        _ => return Err(invalid("Artwork media is not a supported image")),
    };
    let title: String = row["title"]
        .as_str()
        .unwrap_or("作品")
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(40)
        .collect();
    let digest = canonical::digest(stringify(&row["id"]));
    Ok(format!(
        "{index:06}_{}_{digest:.8}.{extension}",
        title.trim().trim_end_matches('.')
    ))
}
fn check_directory(
    directory: &std::path::Path,
    native: &crate::file_identity::Identity,
) -> Result<()> {
    schema::safe(directory, "")?;
    let current = crate::file_identity::path(directory, true)?;
    if current.dev != native.dev || current.ino != native.ino {
        return Err(invalid("Export directory changed"));
    }
    Ok(())
}
impl Storage {
    pub(crate) async fn export_artwork_images(
        &self,
        target: PathBuf,
        principal: String,
        id: String,
        job: Arc<crate::workspace_jobs::Job>,
    ) -> Result<Value> {
        schema::safe(&target, "")?;
        let target = std::fs::canonicalize(target)?;
        let stamp = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now())
            .ok_or_else(|| invalid("System clock is out of range"))?;
        let directory = target.join(format!(
            "绘遇原图-{}-{}",
            stamp.format("%Y%m%d-%H%M%SZ"),
            &id[..8]
        ));
        let mut query = json!({"kind":"readArtworkExportPage"});
        let mut page = self.request(query.clone(), &principal).await?;
        let total = page["total"]
            .as_u64()
            .ok_or_else(|| invalid("Invalid export count"))?;
        if total == 0 {
            return Ok(json!({"path":target,"mediaCount":0}));
        }
        std::fs::create_dir(&directory)?;
        let native = crate::file_identity::path(&directory, true)?;
        let mut completed = 0u64;
        job.progress("exporting-images", 0, total);
        let result = async {
            loop {
                for row in page["items"]
                    .as_array()
                    .ok_or_else(|| invalid("Invalid export page"))?
                {
                    job.check()?;
                    let alias = string(row, "imageId")?;
                    let source = self.open_media(alias).await?;
                    let name = filename(completed + 1, row, &source.media.mime)?;
                    let file = source.file.try_clone().await?.into_std().await;
                    let (folder, job_copy, closed) =
                        (directory.clone(), job.clone(), source.closed.clone());
                    let (bytes, hash) = (source.media.total_bytes, source.media.sha256.clone());
                    let native_copy = native.clone();
                    let pending =
                        tokio::task::spawn_blocking(move || -> Result<tempfile::TempPath> {
                            check_directory(&folder, &native_copy)?;
                            let (mut output, pending) =
                                tempfile::NamedTempFile::new_in(&folder)?.into_parts();
                            let mut input = file;
                            let mut left = bytes;
                            let mut buffer = vec![0; 1024 * 1024];
                            let mut digest = Sha256::new();
                            while left > 0 {
                                job_copy.check()?;
                                if closed.is_cancelled() {
                                    return Err(unavailable());
                                }
                                let amount = left.min(buffer.len() as u64) as usize;
                                input.read_exact(&mut buffer[..amount])?;
                                output.write_all(&buffer[..amount])?;
                                digest.update(&buffer[..amount]);
                                left -= amount as u64;
                            }
                            if input.read(&mut [0; 1])? != 0
                                || hex::encode(digest.finalize()) != hash
                            {
                                return Err(invalid("Artwork source changed during export"));
                            }
                            output.sync_all()?;
                            check_directory(&folder, &native_copy)?;
                            Ok(pending)
                        })
                        .await
                        .map_err(|_| unavailable())??;
                    let closed = source.closed.clone();
                    self.finish_media(alias, source).await?;
                    job.check()?;
                    if closed.is_cancelled() {
                        return Err(unavailable());
                    }
                    check_directory(&directory, &native)?;
                    pending
                        .persist_noclobber(schema::safe(&directory, &name)?)
                        .map_err(|e| ApiError::from(e.error))?;
                    completed += 1;
                    job.progress("exporting-images", completed, total);
                }
                if page["nextCursor"].is_null() {
                    break;
                }
                query["cursor"] = page["nextCursor"].take();
                query["revision"] = page["revision"].clone();
                page = self.request(query.clone(), &principal).await?;
            }
            Ok(json!({"path":directory,"mediaCount":completed}))
        }
        .await;
        result.map_err(|mut error: ApiError| {
            error.message = format!(
                "{}；已保存 {completed}/{total} 张，文件夹：{}",
                error.message,
                directory.display()
            );
            error
        })
    }
}
