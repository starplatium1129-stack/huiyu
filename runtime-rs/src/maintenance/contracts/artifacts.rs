use super::*;
use std::io::Read;
pub(super) fn validate(root: &Path, issues: &mut Vec<String>) {
    let data = root.join("data");
    if !data.exists() {
        return;
    }
    if let Err(error) = walk(root, &data, issues) {
        issues.push(format!("precompressed artifact audit failed: {error}"));
    }
}
fn walk(root: &Path, directory: &Path, issues: &mut Vec<String>) -> Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        let kind = entry.file_type()?;
        if kind.is_dir() {
            fs::safe(&path, true, false)?;
            walk(root, &path, issues)?;
            continue;
        }
        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("");
        if !matches!(extension, "br" | "gz") {
            continue;
        }
        let source = path.with_extension("");
        let relative = path.strip_prefix(root).unwrap_or(&path).display();
        if !source.exists() {
            issues.push(format!("orphan precompressed artifact: {relative} (源 json 已不存在，删除该产物或重跑 npm run precompress)"));
            continue;
        }
        fs::safe(&path, false, false)?;
        fs::safe(&source, false, false)?;
        let packed = std::fs::File::open(&path)?;
        let decoded: Box<dyn Read> = if extension == "br" {
            Box::new(brotli::Decompressor::new(packed, 8192))
        } else {
            Box::new(flate2::read::GzDecoder::new(packed))
        };
        match equal_streams(std::fs::File::open(source)?,decoded) {
            Ok(true)=>{},
            Ok(false)=>issues.push(format!("{relative} 与源文件内容不一致（改过源 json 后必须重跑 npm run precompress，否则服务端会静默发送过期压缩数据）")),
            Err(error)=>issues.push(format!("{relative} cannot be decompressed: {error}")),
        }
    }
    Ok(())
}
fn equal_streams(mut source: impl Read, mut decoded: impl Read) -> std::io::Result<bool> {
    let mut expected = [0u8; 8192];
    let mut actual = [0u8; 8192];
    loop {
        let length = source.read(&mut expected)?;
        if length == 0 {
            return Ok(decoded.read(&mut actual[..1])? == 0);
        }
        let mut offset = 0;
        while offset < length {
            let count = decoded.read(&mut actual[offset..length])?;
            if count == 0 {
                return Ok(false);
            }
            offset += count;
        }
        if expected[..length] != actual[..length] {
            return Ok(false);
        }
    }
}
