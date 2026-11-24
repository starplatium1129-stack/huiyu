use flate2::read::DeflateDecoder;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::LazyLock,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PackKind {
    Portraits,
    Showcase,
}

struct ZipEntry {
    name: String,
    method: u16,
    crc32: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    local_header_offset: u64,
    external_attrs: u32,
}

const EOCD_SIG: u32 = 0x0605_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const CD_SIG: u32 = 0x0201_4b50;
const LFH_SIG: u32 = 0x0403_4b50;
pub(super) const MAX_FILES: usize = 100_000;
pub(super) const MAX_PACK_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
static PORTRAIT_NAME: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^popular-[a-z0-9_-]+\.(?:png|jpe?g|webp)$").unwrap()
});
static SHOWCASE_NAME: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?i)^(?:sc[0-9]{3,}|artist_[a-z0-9_-]+|pc_[a-z0-9_-]+|lora_[a-z0-9_-]+)\.(?:jpg|png|webp)$").unwrap()
});

fn read_u16(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}
fn read_u32(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
fn read_u64(b: &[u8], off: usize) -> u64 {
    u64::from_le_bytes([
        b[off],
        b[off + 1],
        b[off + 2],
        b[off + 3],
        b[off + 4],
        b[off + 5],
        b[off + 6],
        b[off + 7],
    ])
}

fn crc32_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if (c & 1) != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *slot = c;
    }
    table
}

fn crc32_update(table: &[u32; 256], mut crc: u32, bytes: &[u8]) -> u32 {
    for &b in bytes {
        crc = table[((crc ^ u32::from(b)) & 0xff) as usize] ^ (crc >> 8);
    }
    crc
}

fn read_entries(file: &mut File) -> Result<Vec<ZipEntry>, String> {
    let len = file
        .seek(SeekFrom::End(0))
        .map_err(|e| format!("读取压缩包大小失败：{e}"))?;
    if len < 22 {
        return Err("压缩包不完整（小于最小 ZIP 头）".into());
    }
    let tail_len = len.min(65535 + 22) as usize;
    let tail_start = len - tail_len as u64;
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|e| format!("定位压缩包目录失败：{e}"))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| format!("读取压缩包尾部失败：{e}"))?;

    let mut eocd_pos = None;
    for pos in (0..=tail_len - 22).rev() {
        if read_u32(&tail, pos) == EOCD_SIG {
            let comment_len = read_u16(&tail, pos + 20) as usize;
            if pos + 22 + comment_len == tail_len {
                eocd_pos = Some(pos);
                break;
            }
        }
    }
    let eocd_pos = eocd_pos.ok_or_else(|| "无法识别 ZIP 目录结构（缺少 EOCD）".to_string())?;
    let eocd_file_offset = tail_start + eocd_pos as u64;
    let mut entry_count = u64::from(read_u16(&tail, eocd_pos + 10));
    let mut cd_size = u64::from(read_u32(&tail, eocd_pos + 12));
    let mut cd_offset = u64::from(read_u32(&tail, eocd_pos + 16));

    if (entry_count == 0xffff || cd_size == 0xffff_ffff || cd_offset == 0xffff_ffff)
        && eocd_file_offset >= 20
    {
        let mut loc = [0u8; 20];
        file.seek(SeekFrom::Start(eocd_file_offset - 20))
            .map_err(|e| format!("读取 ZIP64 定位器失败：{e}"))?;
        file.read_exact(&mut loc)
            .map_err(|e| format!("读取 ZIP64 定位器失败：{e}"))?;
        if read_u32(&loc, 0) == ZIP64_LOCATOR_SIG {
            let z64_offset = read_u64(&loc, 8);
            let mut z64 = [0u8; 56];
            file.seek(SeekFrom::Start(z64_offset))
                .map_err(|e| format!("读取 ZIP64 目录头失败：{e}"))?;
            file.read_exact(&mut z64)
                .map_err(|e| format!("读取 ZIP64 目录头失败：{e}"))?;
            if read_u32(&z64, 0) != ZIP64_EOCD_SIG {
                return Err("ZIP64 目录头签名无效".into());
            }
            entry_count = read_u64(&z64, 32);
            cd_size = read_u64(&z64, 40);
            cd_offset = read_u64(&z64, 48);
        }
    }

    if entry_count > MAX_FILES as u64 || cd_size > 128 * 1024 * 1024 || cd_offset.saturating_add(cd_size) > eocd_file_offset {
        return Err("ZIP 中央目录超出安全限制或已损坏".into());
    }
    file.seek(SeekFrom::Start(cd_offset))
        .map_err(|e| format!("定位 ZIP 中央目录失败：{e}"))?;
    let mut cd = vec![0u8; cd_size as usize];
    file.read_exact(&mut cd)
        .map_err(|e| format!("读取 ZIP 中央目录失败：{e}"))?;

    let mut entries = Vec::with_capacity(entry_count as usize);
    let mut cursor = 0usize;
    for _ in 0..entry_count {
        if cursor + 46 > cd.len() || read_u32(&cd, cursor) != CD_SIG {
            return Err("ZIP 中央目录记录已损坏".into());
        }
        let method = read_u16(&cd, cursor + 10);
        let crc32 = read_u32(&cd, cursor + 16);
        let mut compressed_size = u64::from(read_u32(&cd, cursor + 20));
        let mut uncompressed_size = u64::from(read_u32(&cd, cursor + 24));
        let name_len = read_u16(&cd, cursor + 28) as usize;
        let extra_len = read_u16(&cd, cursor + 30) as usize;
        let comment_len = read_u16(&cd, cursor + 32) as usize;
        let external_attrs = read_u32(&cd, cursor + 38);
        let mut local_header_offset = u64::from(read_u32(&cd, cursor + 42));

        let name_start = cursor + 46;
        let extra_start = name_start + name_len;
        let next = extra_start + extra_len + comment_len;
        if next > cd.len() {
            return Err("ZIP 条目长度越界".into());
        }
        let name = std::str::from_utf8(&cd[name_start..extra_start])
            .map_err(|_| "ZIP 文件名不是有效 UTF-8".to_string())?
            .to_owned();

        // Parse ZIP64 extra field (header ID 0x0001) when any 32-bit field is 0xffffffff.
        let mut ex = extra_start;
        let ex_end = extra_start + extra_len;
        while ex + 4 <= ex_end {
            let id = read_u16(&cd, ex);
            let sz = read_u16(&cd, ex + 2) as usize;
            let body = ex + 4;
            if body + sz > ex_end {
                break;
            }
            if id == 0x0001 {
                let mut pos = body;
                if uncompressed_size == 0xffff_ffff && pos + 8 <= body + sz {
                    uncompressed_size = read_u64(&cd, pos);
                    pos += 8;
                }
                if compressed_size == 0xffff_ffff && pos + 8 <= body + sz {
                    compressed_size = read_u64(&cd, pos);
                    pos += 8;
                }
                if local_header_offset == 0xffff_ffff && pos + 8 <= body + sz {
                    local_header_offset = read_u64(&cd, pos);
                }
                break;
            }
            ex = body + sz;
        }
        entries.push(ZipEntry {
            name,
            method,
            crc32,
            compressed_size,
            uncompressed_size,
            local_header_offset,
            external_attrs,
        });
        cursor = next;
    }
    Ok(entries)
}

fn sanitize_target(kind: PackKind, raw_name: &str) -> Result<Option<PathBuf>, String> {
    if raw_name.contains(['\\', '\0', ':']) || raw_name.starts_with('/') {
        return Err(format!("压缩包内含非法路径：{raw_name}"));
    }
    let parts = raw_name.strip_suffix('/').unwrap_or(raw_name).split('/');
    if parts.clone().any(|p| p.is_empty() || p.starts_with('.')) {
        return Err(format!("压缩包内含越界或隐藏路径：{raw_name}"));
    }
    if raw_name.ends_with('/') {
        return Ok(None);
    }
    match kind {
        PackKind::Portraits => {
            let normalized = raw_name
                .strip_prefix("pack/")
                .unwrap_or(raw_name);
            let file_name = if let Some(tail) = normalized.strip_prefix("assets/characters/") {
                tail
            } else if let Some(tail) = normalized.strip_prefix("characters/") {
                tail
            } else if !normalized.contains('/') {
                normalized
            } else {
                return Ok(None);
            };
            if PORTRAIT_NAME.is_match(file_name) {
                Ok(Some(PathBuf::from("assets").join("characters").join(file_name)))
            } else {
                Ok(None)
            }
        }
        PackKind::Showcase => {
            let normalized = raw_name
                .strip_prefix("showcase/")
                .unwrap_or(raw_name);
            if normalized == "manifest.json" {
                return Ok(Some(PathBuf::from("manifest.json")));
            }
            if let Some((dir, file_name)) = normalized.split_once('/')
                && matches!(dir, "images" | "thumbs")
                && SHOWCASE_NAME.is_match(file_name)
            {
                return Ok(Some(PathBuf::from(dir).join(file_name)));
            }
            Ok(None)
        }
    }
}

pub(super) fn extract_pack<F>(
    archive_path: &Path,
    dest_dir: &Path,
    kind: PackKind,
    expected: (usize, u64),
    cancel: &CancellationToken,
    mut on_progress: F,
) -> Result<(usize, u64), String>
where
    F: FnMut(usize, usize),
{
    let mut file = File::open(archive_path).map_err(|e| format!("打开资源压缩包失败：{e}"))?;
    let archive_bytes = file.metadata().map_err(|e| format!("读取压缩包大小失败：{e}"))?.len();
    let entries = read_entries(&mut file)?;
    let mut targets = Vec::new();
    let mut paths = HashSet::new();
    let mut declared_bytes = 0_u64;
    for entry in entries {
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        // Reject Unix symlinks stored in ZIP external attributes.
        let unix_mode = (entry.external_attrs >> 16) & 0o170000;
        if unix_mode == 0o120000 {
            return Err(format!("拒绝解压符号链接：{}", entry.name));
        }
        if let Some(rel) = sanitize_target(kind, &entry.name)? {
            if !paths.insert(rel.to_string_lossy().to_ascii_lowercase()) {
                return Err(format!("压缩包包含重复目标：{}", entry.name));
            }
            declared_bytes = declared_bytes.saturating_add(entry.uncompressed_size);
            if entry.uncompressed_size > MAX_FILE_BYTES || declared_bytes > expected.1 {
                return Err(format!("ZIP 解压大小超过资源索引或单文件限制：{}", entry.name));
            }
            targets.push((entry, rel));
        }
    }
    if targets.is_empty() || (targets.len(), declared_bytes) != expected {
        return Err("资源压缩包的文件数或解压大小与索引不匹配".into());
    }
    if kind == PackKind::Showcase
        && (!paths.contains("manifest.json")
            || !paths.iter().any(|path| path.starts_with("images")))
    {
        return Err("样张资源包缺少 manifest.json 或原图".into());
    }
    fs::create_dir_all(dest_dir).map_err(|e| format!("创建解压目录失败：{e}"))?;
    let table = crc32_table();
    let total = targets.len();
    let mut extracted_files = 0usize;
    let mut extracted_bytes = 0u64;
    let mut buf = vec![0u8; 256 * 1024];

    for (index, (entry, rel)) in targets.into_iter().enumerate() {
        if cancel.is_cancelled() {
            return Err("CANCELLED".into());
        }
        file.seek(SeekFrom::Start(entry.local_header_offset))
            .map_err(|e| format!("定位压缩条目失败：{e}"))?;
        let mut lfh = [0u8; 30];
        file.read_exact(&mut lfh)
            .map_err(|e| format!("读取本地文件头失败：{e}"))?;
        if read_u32(&lfh, 0) != LFH_SIG {
            return Err(format!("ZIP 本地文件头损坏：{}", entry.name));
        }
        let lfh_name_len = u64::from(read_u16(&lfh, 26));
        let lfh_extra_len = u64::from(read_u16(&lfh, 28));
        let data_offset = entry
            .local_header_offset
            .checked_add(30 + lfh_name_len + lfh_extra_len)
            .ok_or_else(|| "ZIP 偏移溢出".to_string())?;
        if data_offset.checked_add(entry.compressed_size).is_none_or(|end| end > archive_bytes)
            || (entry.method == 0 && entry.compressed_size != entry.uncompressed_size)
        {
            return Err(format!("ZIP 条目数据范围无效：{}", entry.name));
        }
        file.seek(SeekFrom::Start(data_offset))
            .map_err(|e| format!("定位压缩数据失败：{e}"))?;

        let out_path = dest_dir.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut out = File::create_new(&out_path).map_err(|e| format!("写入文件失败：{e}"))?;
        let limited = (&mut file).take(entry.compressed_size);
        let mut crc = 0xffff_ffffu32;
        let mut written = 0u64;

        let mut reader: Box<dyn Read + '_> = match entry.method {
            0 => Box::new(limited),
            8 => Box::new(DeflateDecoder::new(limited)),
            other => return Err(format!("不支持的 ZIP 压缩方式：{other}")),
        };
        loop {
            if cancel.is_cancelled() {
                return Err("CANCELLED".into());
            }
            let n = reader.read(&mut buf).map_err(|e| format!("解压读取失败：{e}"))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > entry.uncompressed_size {
                return Err(format!("ZIP 条目解压超出声明大小：{}", entry.name));
            }
            crc = crc32_update(&table, crc, &buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| format!("写入磁盘失败：{e}"))?;
        }
        out.flush().map_err(|e: io::Error| format!("刷盘失败：{e}"))?;
        if written != entry.uncompressed_size || (crc ^ 0xffff_ffff) != entry.crc32 {
            return Err(format!("文件校验失败（CRC 或长度不匹配）：{}", entry.name));
        }
        extracted_files += 1;
        extracted_bytes += written;
        if (index + 1) % 8 == 0 || index + 1 == total {
            on_progress(index + 1, total);
        }
    }

    Ok((extracted_files, extracted_bytes))
}
