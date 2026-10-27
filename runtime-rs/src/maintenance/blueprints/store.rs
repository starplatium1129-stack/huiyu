use super::*;
use crate::file_paths;
fn json(bytes: &[u8], label: &str) -> Result<Value> {
    serde_json::from_slice(bytes).map_err(|_| {
        Error::new(
            400,
            "BLUEPRINT_SOURCE_INVALID",
            format!("{label} 不是合法 JSON"),
        )
    })
}
fn read_sources(root: &Path, folder: &str, field: &str) -> Result<Vec<Value>> {
    fs::safe(root, true, false)?;
    fs::safe(&root.join("data"), true, false)?;
    let directory = root.join("data").join(folder);
    fs::safe(&directory, true, false)?;
    let file = directory.join("manifest.json");
    let bytes = fs::read(&file, false)?.unwrap();
    let manifest = json(&bytes, &format!("{folder}/manifest.json"))?;
    drop(bytes);
    let entries = manifest["files"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            Error::new(
                400,
                "BLUEPRINT_SOURCE_INVALID",
                format!("data/{folder}/manifest.json 必须声明非空 files 数组"),
            )
        })?;
    let (mut rows, mut names) = (Vec::new(), HashSet::new());
    for entry in entries {
        let name = entry["file"]
            .as_str()
            .filter(|name| safe_name(name))
            .ok_or_else(|| Error::path("分片文件名不安全"))?;
        if !names.insert(name.to_ascii_lowercase()) {
            return Err(Error::path("分片文件名在 Windows 大小写不敏感下重复"));
        }
        let file = directory.join(name);
        let bytes = fs::read(&file, false)?.unwrap();
        let mut data = json(&bytes, name)?;
        drop(bytes);
        let values = data
            .get_mut(field)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| Error::invalid(format!("{name} 根必须含 {field} 数组")))?;
        rows.append(values);
    }
    Ok(rows)
}
pub fn load(root: &Path) -> Result<Vec<Value>> {
    let root = file_paths::absolute(root)?;
    read_sources(&root, "blueprints", "blueprints")
}
pub(crate) fn load_popular(root: &Path) -> Result<Vec<Value>> {
    read_sources(&file_paths::absolute(root)?, "popular", "characters")
}
