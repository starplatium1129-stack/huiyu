use flate2::read::DeflateDecoder;
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
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

    if entry_count > 100_000 || cd_size > 128 * 1024 * 1024 || cd_offset.saturating_add(cd_size) > len {
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
    if raw_name.ends_with('/') {
        return Ok(None);
    }
    if raw_name.contains(['\\', '\0', ':']) || raw_name.starts_with('/') {
        return Err(format!("压缩包内含非法路径：{raw_name}"));
    }
    let parts: Vec<&str> = raw_name.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.starts_with('.')) {
        return Err(format!("压缩包内含越界或隐藏路径：{raw_name}"));
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
            let lower = file_name.to_ascii_lowercase();
            let valid_ext = lower.ends_with(".png")
                || lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".webp");
            if !file_name.contains('/') && lower.starts_with("popular-") && valid_ext {
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
                && !file_name.contains('/')
            {
                let lower = file_name.to_ascii_lowercase();
                if lower.ends_with(".jpg") || lower.ends_with(".png") || lower.ends_with(".webp") {
                    return Ok(Some(PathBuf::from(dir).join(file_name)));
                }
            }
            Ok(None)
        }
    }
}

pub(super) fn extract_pack<F>(
    archive_path: &Path,
    dest_dir: &Path,
    kind: PackKind,
    cancel: &CancellationToken,
    mut on_progress: F,
) -> Result<(usize, u64), String>
where
    F: FnMut(usize, usize),
{
    let mut file = File::open(archive_path).map_err(|e| format!("打开资源压缩包失败：{e}"))?;
    let entries = read_entries(&mut file)?;
    let mut targets = Vec::new();
    for entry in entries {
        // Reject Unix symlinks stored in ZIP external attributes.
        let unix_mode = (entry.external_attrs >> 16) & 0o170000;
        if unix_mode == 0o120000 {
            return Err(format!("拒绝解压符号链接：{}", entry.name));
        }
        if let Some(rel) = sanitize_target(kind, &entry.name)? {
            targets.push((entry, rel));
        }
    }
    if targets.is_empty() {
        return Err("资源压缩包内未找到有效内容文件".into());
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
        file.seek(SeekFrom::Start(data_offset))
            .map_err(|e| format!("定位压缩数据失败：{e}"))?;

        let out_path = dest_dir.join(&rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut out = File::create(&out_path).map_err(|e| format!("写入文件失败：{e}"))?;
        let mut limited = (&mut file).take(entry.compressed_size);
        let mut crc = 0xffff_ffffu32;
        let mut written = 0u64;

        match entry.method {
            0 => loop {
                if cancel.is_cancelled() {
                    return Err("CANCELLED".into());
                }
                let n = limited
                    .read(&mut buf)
                    .map_err(|e| format!("解压读取失败：{e}"))?;
                if n == 0 {
                    break;
                }
                crc = crc32_update(&table, crc, &buf[..n]);
                out.write_all(&buf[..n])
                    .map_err(|e| format!("写入磁盘失败：{e}"))?;
                written += n as u64;
            },
            8 => {
                let mut decoder = DeflateDecoder::new(limited);
                loop {
                    if cancel.is_cancelled() {
                        return Err("CANCELLED".into());
                    }
                    let n = decoder
                        .read(&mut buf)
                        .map_err(|e| format!("DEFLATE 解压失败：{e}"))?;
                    if n == 0 {
                        break;
                    }
                    crc = crc32_update(&table, crc, &buf[..n]);
                    out.write_all(&buf[..n])
                        .map_err(|e| format!("写入磁盘失败：{e}"))?;
                    written += n as u64;
                }
            }
            other => return Err(format!("不支持的 ZIP 压缩方式：{other}")),
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

    if kind == PackKind::Showcase && !dest_dir.join("manifest.json").is_file() {
        return Err("样张资源包缺少 manifest.json".into());
    }
    Ok((extracted_files, extracted_bytes))
}
