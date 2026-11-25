use super::{
    MediaPacksService,
    archive::{self, PackKind},
    storage::{
        InstalledRecord, RemotePack, TaskState, build_candidates, download_offset, is_sha256,
        now_ms, read_json_file, valid_http_url, write_json_atomic,
    },
};
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, RANGE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_util::sync::CancellationToken;

impl MediaPacksService {
    fn update_task(&self, f: impl FnOnce(&mut TaskState)) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(task) = inner.task.as_mut() {
            f(task);
        }
    }

    pub(super) async fn run_install_queue(
        self: Arc<Self>,
        queue: Vec<String>,
        cancel: CancellationToken,
    ) {
        let (index, fetch_err) = tokio::select! {
            biased;
            _ = cancel.cancelled() => (None, None),
            result = self.fetch_remote_index(true) => result,
        };
        if cancel.is_cancelled() {
            self.finish_task("cancelled", "已暂停下载，已下载部分已保留可续传", None);
            return;
        }
        let Some(index) = index else {
            let reason = fetch_err.unwrap_or_else(|| "无法获取在线资源索引".into());
            self.finish_task(
                "failed",
                "获取在线资源索引失败",
                Some(format!("{reason}。请检查网络或在控制室配置 GitHub 镜像加速，也可直接使用本地离线素材包导入。")),
            );
            return;
        };

        for pack_id in queue {
            if cancel.is_cancelled() {
                self.finish_task("cancelled", "已暂停下载，已下载部分已保留可续传", None);
                return;
            }
            let Some(remote) = index.packs.get(&pack_id).cloned() else {
                self.finish_task(
                    "failed",
                    "在线资源索引中未发布该资源包",
                    Some(format!("当前发布页暂未包含 {pack_id} 资源包，请先在 GitHub Release 发布对应资源包或使用本地离线导入。")),
                );
                return;
            };
            if !valid_http_url(&remote.archive.url)
                || remote.archive.url.is_empty()
                || !is_sha256(&remote.archive.sha256)
                || remote.id != pack_id
                || !(1..=archive::MAX_PACK_BYTES).contains(&remote.archive.bytes)
                || !(1..=archive::MAX_PACK_BYTES).contains(&remote.bytes)
                || !(1..=archive::MAX_FILES).contains(&remote.file_count)
            {
                self.finish_task(
                    "failed",
                    "资源包校验信息无效",
                    Some(format!("{pack_id} 资源包的下载地址、校验值或大小无效")),
                );
                return;
            }
            if let Err(error) = self.install_one(&pack_id, &remote, &cancel).await {
                if error == "CANCELLED" || cancel.is_cancelled() {
                    self.finish_task("cancelled", "已暂停下载，已下载部分已保留可续传", None);
                } else {
                    self.finish_task("failed", "资源包安装未完成", Some(error));
                }
                return;
            }
            self.update_task(|t| t.completed_packs.push(pack_id.clone()));
        }

        // Automatically dismiss onboarding once user completed an install run.
        let _ = self.update_settings(None, None, Some(true));
        self.finish_task("completed", "所选资源包已下载并生效，无需重启软件", None);
    }

    fn finish_task(&self, state: &str, message: &str, error: Option<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.cancel = None;
        if let Some(task) = inner.task.as_mut() {
            task.state = state.into();
            task.message = message.into();
            task.error = error;
            task.speed_bps = 0;
            task.finished_at = now_ms();
        }
    }

    async fn install_one(
        self: &Arc<Self>,
        pack_id: &str,
        remote: &RemotePack,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let downloads_dir = self.root.join("downloads");
        fs::create_dir_all(&downloads_dir).map_err(|e| format!("创建下载目录失败：{e}"))?;
        let part_path = downloads_dir.join(format!("{pack_id}.zip.part"));
        let meta_path = downloads_dir.join(format!("{pack_id}.zip.meta.json"));

        #[derive(Serialize, Deserialize)]
        struct PartMeta {
            sha256: String,
            bytes: u64,
        }
        let saved_meta: Option<PartMeta> = read_json_file(&meta_path);
        let mut offset = fs::metadata(&part_path)
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .unwrap_or(0);
        if offset > 0
            && (saved_meta
                .as_ref()
                .is_none_or(|m| !m.sha256.eq_ignore_ascii_case(&remote.archive.sha256) || m.bytes != remote.archive.bytes)
                || offset > remote.archive.bytes)
        {
            let _ = fs::remove_file(&part_path);
            offset = 0;
        }
        write_json_atomic(
            &meta_path,
            &PartMeta {
                sha256: remote.archive.sha256.clone(),
                bytes: remote.archive.bytes,
            },
        )?;

        let label = if pack_id == "portraits" { "人物高清立绘包" } else { "场景样张资源库" };
        self.update_task(|t| {
            t.pack_id = Some(pack_id.to_owned());
            t.phase = "downloading".into();
            t.bytes = offset;
            t.total = remote.archive.bytes;
            t.files_done = 0;
            t.files_total = remote.file_count;
            t.speed_bps = 0;
            t.message = format!("正在连接下载源：{label}…");
        });

        // Step 1: Download with resumable HTTP Range + mirror fallback.
        if offset < remote.archive.bytes {
            let settings = self.settings();
            let candidates = build_candidates(&remote.archive.url, &settings.mirror_origin);
            let mut downloaded = false;
            let mut last_error = String::from("所有下载源均连接失败");

            for (candidate_url, mirror_label) in candidates {
                if cancel.is_cancelled() {
                    return Err("CANCELLED".into());
                }
                self.update_task(|t| {
                    t.mirror_label = mirror_label.clone();
                    t.message = format!("正在通过{mirror_label}下载{label}…");
                });
                let mut headers = HeaderMap::new();
                if offset > 0
                    && let Ok(val) = format!("bytes={offset}-").parse()
                {
                    headers.insert(RANGE, val);
                }
                let response = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("CANCELLED".into()),
                    res = tokio::time::timeout(Duration::from_secs(25), self.client.get(&candidate_url).headers(headers).send()) => {
                        match res {
                            Ok(Ok(r)) => r,
                            Ok(Err(e)) => { last_error = format!("{mirror_label}连接失败：{e}"); continue; }
                            Err(_) => { last_error = format!("{mirror_label}连接超时"); continue; }
                        }
                    }
                };
                let status = response.status();
                if !status.is_success() {
                    if status.as_u16() == 416 && offset > 0 {
                        let _ = fs::remove_file(&part_path);
                        offset = 0;
                    }
                    last_error = format!("{mirror_label}返回 HTTP {}", status.as_u16());
                    continue;
                }
                let total = remote.archive.bytes;
                let Some(start) = download_offset(&response, offset, total) else {
                    last_error = format!("{mirror_label} 返回的下载范围或长度与索引不匹配");
                    continue;
                };
                offset = start;
                let append = offset > 0;
                let std_file = fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .append(append)
                    .truncate(!append)
                    .open(&part_path)
                    .map_err(|e| format!("打开下载缓存文件失败：{e}"))?;
                let mut writer = BufWriter::with_capacity(256 * 1024, tokio::fs::File::from_std(std_file));
                let mut stream = response.bytes_stream();
                let mut received = offset;
                let mut window_bytes = 0u64;
                let mut last_tick = Instant::now();
                let mut stream_err = None;

                loop {
                    let next_chunk = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => {
                            let _ = writer.flush().await;
                            self.update_task(|t| t.bytes = received);
                            return Err("CANCELLED".into());
                        }
                        item = tokio::time::timeout(Duration::from_secs(30), stream.next()) => item,
                    };
                    match next_chunk {
                        Ok(Some(Ok(chunk))) => {
                            let n = chunk.len() as u64;
                            if received.saturating_add(n) > total {
                                stream_err = Some(format!("{mirror_label} 返回的下载数据超过索引大小"));
                                break;
                            }
                            if let Err(e) = writer.write_all(&chunk).await {
                                stream_err = Some(format!("写入磁盘失败：{e}"));
                                break;
                            }
                            received += n;
                            window_bytes += n;
                            let elapsed = last_tick.elapsed();
                            if elapsed >= Duration::from_millis(250) {
                                let bps = ((window_bytes as f64) / elapsed.as_secs_f64()).round() as u64;
                                self.update_task(|t| {
                                    t.bytes = received;
                                    t.total = total;
                                    t.speed_bps = bps;
                                });
                                window_bytes = 0;
                                last_tick = Instant::now();
                            }
                        }
                        Ok(Some(Err(e))) => {
                            stream_err = Some(format!("{mirror_label}传输中断：{e}"));
                            break;
                        }
                        Ok(None) => break,
                        Err(_) => {
                            stream_err = Some(format!("{mirror_label}读取超时"));
                            break;
                        }
                    }
                }
                writer.flush().await.map_err(|e| format!("刷盘失败：{e}"))?;
                drop(writer);
                offset = received;
                self.update_task(|t| {
                    t.bytes = received;
                    t.total = total;
                });

                if let Some(err) = stream_err {
                    last_error = err;
                    continue;
                }
                if received != remote.archive.bytes {
                    last_error = format!("{mirror_label}下载不完整（{received}/{} 字节）", remote.archive.bytes);
                    continue;
                }
                downloaded = true;
                break;
            }
            if !downloaded {
                return Err(format!("下载{label}失败：{last_error}"));
            }
        }

        // Step 2: Verify SHA-256 of completed archive.
        self.update_task(|t| {
            t.phase = "verifying".into();
            t.speed_bps = 0;
            t.message = format!("正在校验{label}完整性（SHA-256）…");
        });
        let verify_path = part_path.clone();
        let verify_cancel = cancel.clone();
        let expected_sha = remote.archive.sha256.clone();
        let actual_sha = tokio::task::spawn_blocking(move || -> Result<String, String> {
            use std::io::Read;
            let mut file = fs::File::open(&verify_path).map_err(|e| format!("读取下载包失败：{e}"))?;
            let mut hasher = Sha256::new();
            let mut buf = vec![0u8; 512 * 1024];
            loop {
                if verify_cancel.is_cancelled() {
                    return Err("CANCELLED".into());
                }
                let n = file.read(&mut buf).map_err(|e| format!("校验读取失败：{e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            Ok(hex::encode(hasher.finalize()))
        })
        .await
        .map_err(|_| "校验任务异常中断".to_string())??;
        if !actual_sha.eq_ignore_ascii_case(&expected_sha) {
            let _ = fs::remove_file(&part_path);
            let _ = fs::remove_file(&meta_path);
            return Err(format!("{label}完整性校验不通过，已清理损坏缓存，请重新下载"));
        }

        // Step 3: Extract into isolated staging dir and atomically swap into current.
        let pack_root = self.root.join(pack_id);
        let staging_dir = pack_root.join(format!("staging-{}", uuid::Uuid::new_v4()));
        let current_dir = pack_root.join("current");
        let previous_dir = pack_root.join(format!("previous-{}", uuid::Uuid::new_v4()));
        let kind = if pack_id == "portraits" {
            PackKind::Portraits
        } else {
            PackKind::Showcase
        };

        self.update_task(|t| {
            t.phase = "extracting".into();
            t.files_done = 0;
            t.files_total = remote.file_count;
            t.message = format!("正在解压安装{label}…");
        });
        let extract_archive = part_path.clone();
        let extract_dest = staging_dir.clone();
        let extract_cancel = cancel.clone();
        let progress_service = Arc::clone(self);
        let expected = (remote.file_count, remote.bytes);
        let (file_count, extracted_bytes) = tokio::task::spawn_blocking(move || {
            archive::extract_pack(&extract_archive, &extract_dest, kind, expected, &extract_cancel, |done, total| {
                progress_service.update_task(|t| {
                    t.files_done = done;
                    t.files_total = total;
                });
            })
        })
        .await
        .map_err(|_| "解压任务异常中断".to_string())?
        .inspect_err(|_| {
            let _ = fs::remove_dir_all(&staging_dir);
        })?;
        if cancel.is_cancelled() {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err("CANCELLED".into());
        }

        self.update_task(|t| {
            t.phase = "switching".into();
            t.message = format!("正在启用{label}…");
        });
        let swap_res = (|| -> Result<(), String> {
            let had_current = current_dir.exists();
            if had_current {
                fs::rename(&current_dir, &previous_dir).map_err(|e| format!("切换旧资源目录失败：{e}"))?;
            }
            if let Err(e) = fs::rename(&staging_dir, &current_dir) {
                if had_current {
                    let _ = fs::rename(&previous_dir, &current_dir);
                }
                return Err(format!("启用新资源目录失败：{e}"));
            }
            if let Err(error) = write_json_atomic(
                &pack_root.join("installed.json"),
                &InstalledRecord {
                    version: remote.version.clone(),
                    sha256: remote.archive.sha256.clone(),
                    bytes: extracted_bytes,
                    file_count,
                    installed_at: now_ms(),
                },
            ) {
                fs::rename(&current_dir, &staging_dir)
                    .map_err(|e| format!("{error}；撤回新资源目录失败：{e}"))?;
                if had_current {
                    fs::rename(&previous_dir, &current_dir)
                        .map_err(|e| format!("{error}；恢复旧资源目录失败：{e}"))?;
                }
                return Err(error);
            }
            if had_current {
                let _ = fs::remove_dir_all(&previous_dir);
            }
            Ok(())
        })();
        if let Err(e) = swap_res {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(e);
        }
        let _ = fs::remove_file(&part_path);
        let _ = fs::remove_file(&meta_path);
        Ok(())
    }
}
