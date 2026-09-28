use super::*;
use std::path::PathBuf;

pub(super) fn validate(root: &Path, assets_root: Option<&Path>, issues: &mut Vec<String>) -> Value {
    let view = match read(root, "data/character-reference-view.json") {
        Ok(v) => v,
        Err(error) => {
            issues.push(error);
            return Value::Null;
        }
    };
    if !view.is_object() {
        issues.push("character-reference-view: 视图文件不是角色对象表".into());
        return Value::Null;
    }
    let assets = assets_root
        .map(Path::to_path_buf)
        .or_else(|| std::env::var_os("AICS_ASSETS_ROOT").map(PathBuf::from))
        .unwrap_or_else(|| root.join("assets"));
    let assets = std::path::absolute(assets).unwrap_or_else(|_| root.join("assets"));
    let references = crate::reference::reference_root(root).filter(|p| p.is_dir());
    let structure = std::env::var("AICS_REFERENCE_AUDIT_MODE").as_deref() == Ok("structure");
    let (mut total, mut missing, mut pending, mut unverified) = (0, 0, 0, 0);
    for (id, profile) in view.as_object().unwrap() {
        let mut seen = HashSet::new();
        for outfit in list(&profile["outfits"]) {
            let outfit_id = property(outfit, "outfitId");
            if !seen.insert(key(outfit.get("outfitId"))) {
                issues.push(format!(
                    "character-reference-view: {id}: duplicate outfit {outfit_id}"
                ));
            }
            for reference in list(&outfit["references"]) {
                if reference["pending"] == true {
                    pending += 1;
                    continue;
                }
                total += 1;
                let url = reference["url"].as_str().unwrap_or("");
                let prefix = if url.starts_with("/character-references/") {
                    Some(("/character-references/", references.as_deref()))
                } else if url.starts_with("/assets/") {
                    Some(("/assets/", Some(assets.as_path())))
                } else {
                    None
                };
                let target = prefix.and_then(|(prefix, base)| {
                    let suffix = &url[prefix.len()..];
                    if suffix.as_bytes().iter().enumerate().any(|(i, b)| {
                        *b == b'%'
                            && (suffix
                                .as_bytes()
                                .get(i + 1)
                                .is_none_or(|b| !b.is_ascii_hexdigit())
                                || suffix
                                    .as_bytes()
                                    .get(i + 2)
                                    .is_none_or(|b| !b.is_ascii_hexdigit()))
                    }) {
                        return None;
                    }
                    let suffix = percent_encoding::percent_decode_str(suffix)
                        .decode_utf8()
                        .ok()?;
                    if suffix.contains(['?', '#', '\0']) {
                        return None;
                    }
                    let fallback = root.join(".external-reference-audit");
                    let base = base.unwrap_or(&fallback);
                    let path = fs::absolute(&base.join(suffix.as_ref())).ok()?;
                    fs::within(base, &path).then_some(path)
                });
                if target.is_some()
                    && references.is_none()
                    && structure
                    && url.starts_with("/character-references/")
                {
                    unverified += 1;
                    continue;
                }
                if target.is_none_or(|path| !path.is_file()) {
                    missing += 1;
                    if missing <= 15 {
                        issues.push(format!(
                            "character-reference-view: {id}/{outfit_id}: {}",
                            if url.is_empty() { "(missing URL)" } else { url }
                        ));
                    }
                }
            }
        }
    }
    if missing > 0 {
        issues.push(format!(
            "参考图缺失 {missing}/{total}；素材根目录: {}。先确认素材路径与同步，不自动改写索引。",
            references
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "(未配置)".into())
        ));
    }
    json!({"total":total,"missing":missing,"pending":pending,"unverified":unverified,"structureOnly":structure})
}
