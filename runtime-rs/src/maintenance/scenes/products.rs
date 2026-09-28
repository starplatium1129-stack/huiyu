use super::*;
use std::io::{Read, Write};
pub(crate) fn build(root: &Path, scenes: &[Value]) -> Vec<(&'static str, Value)> {
    let sorted = sorted(scenes.to_vec());
    let mut groups = [Vec::new(), Vec::new(), Vec::new()];
    let mut seen = HashSet::new();
    for scene in &sorted {
        if seen.insert(prompt::text(&scene["id"])) {
            let index = match scene["char"].as_str() {
                Some("natsume") => 1,
                Some("triad") => 2,
                _ => 0,
            };
            groups[index].push(scene.clone());
        }
    }
    let curation = fs::json(&root.join("data/curation.json")).unwrap_or(json!({}));
    let core_ids = prompt::strings(&curation["personaCoreSceneIds"])
        .into_iter()
        .take(2000)
        .filter(|id| seen.contains(id))
        .collect::<Vec<_>>();
    let by_id = sorted
        .iter()
        .map(|scene| (scene["id"].as_str().unwrap(), scene))
        .collect::<HashMap<_, _>>();
    let core = core_ids
        .iter()
        .map(|id| by_id[id.as_str()].clone())
        .collect::<Vec<_>>();
    let index = json!({"version":1,"total":sorted.len(),"shards":{"nene":{"file":"scenes-nene.json","count":groups[0].len()},"natsume":{"file":"scenes-natsume.json","count":groups[1].len()},"shared":{"file":"scenes-shared.json","count":groups[2].len()}},"tiers":{"core":core_ids},"orderedIds":sorted.iter().map(|scene|&scene["id"]).collect::<Vec<_>>()});
    vec![
        ("scenes.json", json!(sorted)),
        ("scenes-nene.json", json!(groups[0])),
        ("scenes-natsume.json", json!(groups[1])),
        ("scenes-shared.json", json!(groups[2])),
        ("scenes-core.json", json!(core)),
        ("scenes-index.json", index),
    ]
}
pub(in crate::maintenance) fn aggregate(
    root: &Path,
    scenes: &[Value],
    tx: &Transaction,
) -> Result<()> {
    for (name, value) in build(root, scenes) {
        tx.write(
            &root.join("data").join(name),
            blueprints::json_text(&value).as_bytes(),
        )?;
    }
    Ok(())
}
pub(in crate::maintenance) fn compressed_targets(files: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut targets = files.to_vec();
    for file in files {
        if file.extension().is_some_and(|ext| ext == "json") {
            for suffix in ["gz", "br"] {
                let companion = PathBuf::from(format!("{}.{}", file.display(), suffix));
                if fs::safe(&companion, false, true)?.is_some() {
                    targets.push(companion);
                }
            }
        }
    }
    targets.sort();
    targets.dedup();
    Ok(targets)
}
fn decoded_matches(bytes: &[u8], old: &[u8], suffix: &str) -> bool {
    // Bound decompression to the current raw size plus one, so a malformed
    // historical companion cannot force an unbounded allocation during save.
    let reader: Box<dyn Read> = if suffix == "gz" {
        Box::new(flate2::read::GzDecoder::new(old))
    } else {
        Box::new(brotli::Decompressor::new(old, 8192))
    };
    let mut decoded = Vec::with_capacity(bytes.len());
    reader
        .take(bytes.len() as u64 + 1)
        .read_to_end(&mut decoded)
        .is_ok()
        && decoded == bytes
}
pub(in crate::maintenance) fn refresh_compressed(
    files: &[PathBuf],
    tx: &Transaction,
) -> Result<()> {
    let captured = files.iter().collect::<HashSet<_>>();
    for file in files {
        if !file.extension().is_some_and(|ext| ext == "json") {
            continue;
        }
        let bytes = fs::read(file, true)?;
        for suffix in ["gz", "br"] {
            let companion = PathBuf::from(format!("{}.{}", file.display(), suffix));
            if !captured.contains(&companion) {
                continue;
            }
            let Some(old) = fs::read(&companion, true)? else {
                continue;
            };
            let Some(bytes) = &bytes else {
                tx.remove(&companion)?;
                continue;
            };
            if decoded_matches(bytes, &old, suffix) {
                continue;
            }
            let packed = if suffix == "gz" {
                let mut writer =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                writer.write_all(bytes)?;
                writer.finish()?
            } else {
                let mut out = Vec::new();
                {
                    let mut writer = brotli::CompressorWriter::new(&mut out, 8192, 5, 22);
                    writer.write_all(bytes)?;
                }
                out
            };
            tx.write(&companion, &packed)?;
        }
    }
    Ok(())
}
pub(in crate::maintenance) fn sync_version(root: &Path) -> Result<u64> {
    use sha1::{Digest, Sha1};
    let mut hash = Sha1::new();
    for name in super::super::context::VERSIONED_FILES {
        let bytes = fs::read(&root.join("data").join(name), false)?.unwrap();
        let count = String::from_utf8_lossy(&bytes).encode_utf16().count();
        hash.update(format!("{name}={count};").as_bytes());
        hash.update(bytes);
    }
    Ok(u64::from_str_radix(&hex::encode(hash.finalize())[..8], 16).unwrap())
}
