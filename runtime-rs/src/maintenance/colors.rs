#[cfg(test)]
mod tests;
mod utilities;
use super::{Error, Result, fs, prompt};
use regex::Regex;
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Instant,
};
use tokio_util::sync::CancellationToken;
static CONSTANTS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("colors/constants.json")).expect("Legacy color policy tables")
});
fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("Static color audit regex")
}
fn blank(text: &str) -> String {
    text.chars()
        .map(|c| if c == '\n' { '\n' } else { ' ' })
        .collect()
}
fn comments(source: &str, html: bool) -> String {
    static CSS: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)/\*.*?\*/"));
    static ALL: LazyLock<Regex> = LazyLock::new(|| re(r"(?s)/\*.*?\*/|<!--.*?-->"));
    let pattern = if html { &*ALL } else { &*CSS };
    pattern
        .replace_all(source, |c: &regex::Captures| blank(&c[0]))
        .into_owned()
}
pub(super) fn scan(file: &Path, source: &str) -> Vec<Value> {
    let mut warnings=utilities::literals(source).into_iter().map(|(candidate,line)|json!({"file":file,"line":line,"hex":candidate,"text":"Tailwind 任意颜色必须引用设计令牌"})).collect::<Vec<_>>();
    static APPLY: LazyLock<Regex> = LazyLock::new(|| re(r"@apply\s+[^;]+;"));
    static HEX: LazyLock<Regex> =
        LazyLock::new(|| re(r"#[0-9a-fA-F]{6}(?-u:\b)|#[0-9a-fA-F]{3}(?-u:\b)"));
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| re(r"^\s*--[A-Za-z0-9_]"));
    static STYLE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)<style(?-u:\b)"));
    static END: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)</style>"));
    let stripped = comments(source, false)
        .split('\n')
        .map(|line| {
            if let Some(at) = line.find("//") {
                format!("{}{}", &line[..at], blank(&line[at..]))
            } else {
                line.into()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let content = APPLY.replace_all(&stripped, |c: &regex::Captures| blank(&c[0]));
    let ext = file.extension().and_then(|s| s.to_str()).unwrap_or("");
    let mut in_style = false;
    for (index, line) in content.split('\n').enumerate() {
        if ext == "html" || ext == "vue" {
            if STYLE.is_match(line) {
                in_style = true;
                continue;
            }
            if END.is_match(line) {
                in_style = false;
                continue;
            }
            if !in_style {
                continue;
            }
        } else if ext != "css" {
            continue;
        }
        if TOKEN.is_match(line)
            || line.contains("color-mix(")
            || line.contains("rgba(")
            || ((ext == "html" || ext == "vue") && line.contains("data:image"))
        {
            continue;
        }
        for found in HEX.find_iter(line) {
            if found.start() > 0 && line.as_bytes()[found.start() - 1] == b'#' {
                continue;
            }
            let value = found.as_str();
            if CONSTANTS["allowed"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == value)
            {
                continue;
            }
            let text = prompt::trim(line)
                .encode_utf16()
                .take(120)
                .collect::<Vec<_>>();
            warnings.push(json!({"file":file,"line":index+1,"hex":value,"text":String::from_utf16_lossy(&text)}));
        }
    }
    warnings
}
fn files(
    root: &Path,
    directory: &Path,
    output: &mut Vec<PathBuf>,
    cancel: &CancellationToken,
    started: Instant,
) -> Result<()> {
    super::save::check(cancel, started)?;
    if fs::safe(directory, true, true)?.is_none() {
        return Ok(());
    }
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            if name != "vendor" && name != "archive" {
                files(root, &path, output, cancel, started)?;
            }
        } else {
            let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
            let relative = path
                .strip_prefix(root)
                .map_err(|_| Error::path("颜色扫描路径越界"))?
                .to_string_lossy()
                .replace('\\', "/");
            let accepted = ["html", "css", "vue"].contains(&ext)
                || (ext == "ts"
                    && relative.starts_with("src/")
                    && !name.ends_with(".spec.ts")
                    && !name.ends_with(".d.ts"));
            if accepted
                && !CONSTANTS["reports"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == &relative)
            {
                output.push(path);
            }
        }
    }
    Ok(())
}
pub(super) fn report(root: &Path, cancel: &CancellationToken) -> Result<String> {
    let started = Instant::now();
    let mut paths = Vec::new();
    for directory in ["src", "docs", "css"] {
        files(root, &root.join(directory), &mut paths, cancel, started)?;
    }
    let mut warnings = std::collections::BTreeMap::<String, Vec<Value>>::new();
    for path in paths {
        super::save::check(cancel, started)?;
        let Some(bytes) = fs::read(&path, true)? else {
            continue;
        };
        let source = String::from_utf8_lossy(&bytes);
        let found = scan(&path, &source);
        if !found.is_empty() {
            warnings
                .entry(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                )
                .or_default()
                .extend(found);
        }
    }
    let count = warnings.values().map(Vec::len).sum::<usize>();
    if count == 0 {
        return Ok("✅ No hardcoded colors found. All colors use design tokens.".into());
    }
    let mut output = format!("  ⚠️  {count} hardcoded hex color(s) found:\n\n");
    let mut warnings = warnings.into_iter().collect::<Vec<_>>();
    warnings.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    for (file, entries) in warnings {
        output.push_str(&format!("  {file} ({})\n", entries.len()));
        for item in entries {
            output.push_str(&format!(
                "    L{}: {}  →  {}\n",
                item["line"],
                item["hex"].as_str().unwrap(),
                item["text"].as_str().unwrap()
            ));
        }
        output.push('\n');
    }
    output.push_str("  💡 Run \"npm run lint:colors\" after making CSS changes.\n     See docs/maintenance.md for token reference.\n");
    let mut units = output.encode_utf16().collect::<Vec<_>>();
    if units.len() > 8000 {
        units.truncate(8000);
        output = String::from_utf16_lossy(&units) + "\n...(truncated)";
    }
    Ok(prompt::trim(&output).into())
}
