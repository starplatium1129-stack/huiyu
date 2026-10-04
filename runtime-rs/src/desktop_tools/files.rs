use super::{Error, Result, paths, text};
use base64::{Engine, engine::general_purpose::STANDARD};
use icu_collator::{Collator, options::CollatorOptions};
use icu_locale::Locale;
use serde_json::{Value, json};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

pub(super) async fn list(root: &Path, input: &Value) -> Result<Value> {
    let directory = paths::resolve(root, &text(&input["path"])).await?;
    let mut source = tokio::fs::read_dir(&directory)
        .await
        .map_err(|error| Error::plain(format!("目录不存在或不可读：{error}")))?;
    let mut entries = Vec::new();
    while let Some(entry) = source.next_entry().await? {
        let kind = entry.file_type().await?;
        entries.push((
            kind.is_dir(),
            entry.file_name().to_string_lossy().into_owned(),
            entries.len(),
        ));
    }
    let locale: Locale = crate::collation::system_locale()
        .parse()
        .map_err(|_| Error::plain("目录排序区域设置不可用"))?;
    let collator = Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|_| Error::plain("目录排序不可用"))?;
    // ICU can consider distinct names equal. Preserve their enumeration order
    // when selecting the first page, just as the previous stable full sort did.
    let compare = |(ad, an, ai): &(bool, String, usize), (bd, bn, bi): &(bool, String, usize)| {
        bd.cmp(ad)
            .then_with(|| collator.compare(an, bn))
            .then_with(|| ai.cmp(bi))
    };
    let total = entries.len();
    if total > 200 {
        entries.select_nth_unstable_by(200, &compare);
        entries.truncate(200);
    }
    entries.sort_unstable_by(compare);
    let mut rows = Vec::new();
    for (dir, name, _) in entries {
        if dir {
            rows.push(format!("{name}/"));
        } else {
            let extra = tokio::fs::symlink_metadata(directory.join(&name))
                .await
                .ok()
                .map(|stat| format!(" ({} B)", stat.len()))
                .unwrap_or_default();
            rows.push(format!("{name}{extra}"));
        }
    }
    let count = if total > 200 {
        format!("（前 200 项，共 {total} 项）")
    } else {
        format!("共 {total} 项")
    };
    Ok(
        json!({"ok":true,"output":format!("[{}]\n{}\n{count}",paths::display(&directory),if rows.is_empty(){"(空目录)".into()}else{rows.join("\n")})}),
    )
}
async fn read_bounded(file: &Path, limit: u64, message: &str) -> Result<Vec<u8>> {
    let file = tokio::fs::File::open(file).await?;
    let stat = file.metadata().await?;
    if !stat.is_file() {
        return Err(Error::plain("目标不是文件"));
    }
    if stat.len() > limit {
        return Err(Error::plain(message));
    }
    let mut bytes = Vec::with_capacity(stat.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes).await?;
    if bytes.len() as u64 > limit {
        return Err(Error::plain(message));
    }
    Ok(bytes)
}
pub(super) async fn read(root: &Path, input: &Value) -> Result<Value> {
    let file = paths::resolve(root, &text(&input["path"])).await?;
    let bytes = read_bounded(&file, 1024 * 1024, "文件超过 1024KB 读取上限").await?;
    if bytes.contains(&0) {
        return Err(Error::plain("看起来是二进制文件，不读取"));
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if text.encode_utf16().count() > 500_000 {
        text = truncate(&text, 500_000) + "\n…（内容已截断）";
    }
    Ok(json!({"ok":true,"output":text}))
}
pub(super) async fn write(root: &Path, input: &Value, cancel: &CancellationToken) -> Result<Value> {
    let relative = text(&input["path"]);
    let target = paths::resolve(root, &relative).await?;
    let content = text(&input["content"]);
    let length = content.encode_utf16().count();
    if length > 512 * 1024 {
        return Err(Error::plain("内容超过 512KB 写入上限"));
    }
    atomic(root, &relative, &target, content.as_bytes(), cancel).await?;
    Ok(
        json!({"ok":true,"output":format!("已写入 {}（{length} 字符）",paths::relative(root,&target).await)}),
    )
}
pub(super) async fn atomic(
    root: &Path,
    relative: &str,
    target: &Path,
    bytes: &[u8],
    cancel: &CancellationToken,
) -> Result<()> {
    tokio::fs::create_dir_all(
        target
            .parent()
            .ok_or_else(|| Error::plain("目标路径不可写"))?,
    )
    .await?;
    if cancel.is_cancelled() {
        return Err(Error::cancelled());
    }
    if paths::resolve(root, relative).await? != target {
        return Err(Error::plain("路径在写入期间发生变化"));
    }
    let temporary = target.with_file_name(format!(
        "{}.{}.tool.tmp",
        target.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let _cleanup = Temporary(temporary.clone());
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(bytes).await?;
        // Tokio may still have a background write after write_all returns.
        // Complete it before publishing the path or acknowledging the draft.
        file.flush().await?;
        drop(file);
        if cancel.is_cancelled() {
            return Err(Error::cancelled());
        }
        if paths::resolve(root, relative).await? != target {
            return Err(Error::plain("路径在写入期间发生变化"));
        }
        tokio::fs::rename(&temporary, target).await?;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(temporary).await;
    result
}
struct Temporary(std::path::PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
pub(super) async fn image(root: &Path, input: &Value) -> Result<Value> {
    let file = paths::resolve(root, &text(&input["path"])).await?;
    let bytes = read_bounded(&file, 8 * 1024 * 1024, "图片超过 8MB 上限").await?;
    let mime = if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"RIFF") {
        "image/webp"
    } else if bytes.starts_with(b"GIF") {
        "image/gif"
    } else {
        return Err(Error::plain(
            "不支持的文件格式（仅 PNG / JPEG / WebP / GIF）",
        ));
    };
    Ok(
        json!({"ok":true,"output":format!("已读取图片 {}（{} B，{}）",paths::relative(root,&file).await,bytes.len(),mime.trim_start_matches("image/")),"imageDataUrl":format!("data:{mime};base64,{}",STANDARD.encode(&bytes))}),
    )
}
pub(super) fn truncate(text: &str, max: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(max).collect::<Vec<_>>())
}
