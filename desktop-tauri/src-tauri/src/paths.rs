use std::path::{Path, PathBuf};

use tauri::Manager;

/// dev 模式项目根：desktop-tauri/src-tauri 上两级 = 仓库根
pub const DEV_PROJECT_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

#[derive(Clone)]
pub struct DesktopPaths {
    pub is_packaged: bool,
    pub app_root: PathBuf,
    #[allow(dead_code)]
    pub resource_root: PathBuf,
    pub gateway_executable: PathBuf,
    pub gateway_cwd: PathBuf,
    pub assets_root: PathBuf,
    pub tools_root: PathBuf,
    pub runtime_root: PathBuf,
    pub config_root: PathBuf,
    pub source_profile_id: String,
    pub ai_workspace_file: PathBuf,
    pub desktop_log: PathBuf,
    pub gateway_port_file: PathBuf,
    pub companion_window_file: PathBuf,
    pub companion_chat_window_file: PathBuf,
    pub atelier_window_file: PathBuf,
    pub preferences_file: PathBuf,
}

fn first_existing(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .find(|c| c.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

/// 去掉 Windows `\\?\` UNC 前缀（std::fs::canonicalize 会引入；一些
/// 外部程序解析 `\\?\C:` 会失败）。
fn simplify_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

/// 打包模式使用 resource_dir/gateway/huiyu-runtime.exe；缺失时启动失败。
/// dev 模式（cargo run / tauri dev）直接用仓库根。
pub fn resolve_paths(app: &tauri::AppHandle) -> DesktopPaths {
    let resource_root = simplify_path(
        app.path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from(DEV_PROJECT_ROOT)),
    );
    let config_root = simplify_path(
        std::env::var_os("AICS_DESKTOP_CONFIG_ROOT").map(PathBuf::from).filter(|path| path.is_absolute())
            .unwrap_or_else(|| app.path()
            .app_config_dir()
            .expect("Desktop configuration directory is unavailable")),
    );

    let resources_dir = resource_root.join("resources");
    let gateway_candidates = [
        resource_root.join("gateway"), resources_dir.join("gateway"),
    ];
    let gateway_dir = gateway_candidates.iter().find(|dir|dir.join("huiyu-runtime.exe").is_file())
        .cloned().unwrap_or_else(||first_existing(&gateway_candidates));
    let is_cargo_target = resource_root.file_name().is_some_and(|name| {
        (name == "debug" || name == "release")
            && resource_root.ancestors().skip(1).take(2).any(|parent| parent.file_name().is_some_and(|name| name == "target"))
    }) || option_env!("CARGO_TARGET_DIR").is_some_and(|target| {
        let target=PathBuf::from(target);
        target.is_absolute() && resource_root.starts_with(target)
    });
    // An installed layout missing its executable is a broken installation, never
    // permission to silently read this build machine's source tree or Node files.
    let is_packaged = !is_cargo_target && (gateway_dir.join("huiyu-runtime.exe").is_file() || !cfg!(debug_assertions));
    let app_root = if is_packaged { gateway_dir } else {
        simplify_path(std::fs::canonicalize(DEV_PROJECT_ROOT).unwrap_or_else(|_| PathBuf::from(DEV_PROJECT_ROOT)))
    };
    let gateway_executable = if is_packaged { app_root.join("huiyu-runtime.exe") } else {
        let override_path = if cfg!(debug_assertions) { std::env::var_os("AICS_DESKTOP_RUNTIME_EXE").map(PathBuf::from) } else { None };
        select_dev_runtime(&app_root, override_path)
    };
    // Assets/configuration are rooted at the gateway payload, not target/debug.
    let gateway_cwd = app_root.clone();
    let assets_root = first_existing(&[
        app_root.join("assets"),
        resources_dir.join("assets"),
        resource_root.join("assets"),
    ]);
    let tools_root = first_existing(&[
        app_root.join("tools"),
        resources_dir.join("tools"),
        resource_root.join("tools"),
    ]);
    let runtime_root = config_root.join("gateway");

    let profile_root = crate::ui_entry::isolated_profile().unwrap_or_else(|| app.path().app_local_data_dir().expect("WebView profile directory is unavailable"));
    // Failure retains a closed migration boundary; it does not invent a new
    // identity for unreadable data. The bundled UI can still show diagnostics.
    let source_profile_id = crate::gateway::profile_id(&profile_root).unwrap_or_default();
    DesktopPaths {
        is_packaged,
        app_root,
        resource_root,
        gateway_executable,
        gateway_cwd,
        assets_root,
        tools_root,
        runtime_root,
        config_root: config_root.clone(),
        source_profile_id,
        ai_workspace_file: config_root.join("ai-workspace.json"),
        desktop_log: config_root.join("desktop.log"),
        gateway_port_file: config_root.join("desktop-gateway.json"),
        companion_window_file: config_root.join("companion-window.json"),
        companion_chat_window_file: config_root.join("companion-chat-window.json"),
        atelier_window_file: config_root.join("atelier-window.json"),
        preferences_file: config_root.join("companion-preferences.json"),
    }
}

/// Explicit debug overrides are authoritative even when invalid: start reports
/// the missing/non-absolute executable instead of falling back to another build.
fn select_dev_runtime(root: &Path, override_path: Option<PathBuf>) -> PathBuf {
    if let Some(path) = override_path { return path; }
    let candidates=[
        root.join("runtime-rs/target/debug/huiyu-runtime.exe"),
        root.join("runtime-rs/target/release/huiyu-runtime.exe"),
    ];
    candidates.iter().find(|path|path.is_file()).cloned().unwrap_or_else(||candidates[0].clone())
}
/// Electron 旧版数据目录候选（数据迁移源）：%APPDATA%\ai-cg-studio
pub fn electron_user_data_candidates() -> Vec<PathBuf> {
    let base = std::env::var("APPDATA").unwrap_or_default();
    if base.is_empty() {
        return Vec::new();
    }
    let base = Path::new(&base);
    ["ai-cg-studio", "AI-CG-Studio", "aics-studio"]
        .iter()
        .map(|name| base.join(name))
        .filter(|p| p.is_dir())
        .collect()
}

/// Electron 用户数据 → Tauri 配置目录迁移（幂等：已有标记或目标已存在则跳过）。
/// 返回迁移的文件名列表（空 = 无需迁移）。
pub fn migrate_electron_data(config_root: &Path, runtime_root: &Path) -> Vec<String> {
    let marker = config_root.join(".tauri-migrated");
    if marker.exists() {
        return Vec::new();
    }
    let Some(source) = electron_user_data_candidates().first().cloned() else {
        return Vec::new();
    };
    let mut migrated = Vec::new();
    let copy_if_missing = |_name: &str, from: &Path, to: &Path| -> bool {
        if to.exists() || !from.exists() {
            return false;
        }
        if std::fs::create_dir_all(to.parent().unwrap()).is_err() {
            return false;
        }
        std::fs::copy(from, to).is_ok()
    };

    for name in [
        "companion-window.json",
        "companion-preferences.json",
        "desktop-gateway.json",
        "ai-workspace.json",
    ] {
        if copy_if_missing(name, &source.join(name), &config_root.join(name)) {
            migrated.push(name.to_string());
        }
    }
    // 网关运行时状态（gateway_token 必须复用，AGENTS.md 约束）
    let src_state = source.join("gateway").join("runtime").join("state");
    let dst_state = runtime_root.join("runtime").join("state");
    if let Ok(entries) = std::fs::read_dir(&src_state) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().contains("gateway_token") {
                if copy_if_missing(&name.to_string_lossy().to_string(), &entry.path(), &dst_state.join(&name)) {
                    migrated.push(format!("gateway/runtime/state/{name:?}"));
                }
            }
        }
    }

    if !migrated.is_empty() {
        let _ = std::fs::write(marker, "migrated-at-first-run\n");
    }
    migrated
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn runtime_override_never_falls_back_to_another_build() {
        let root=std::env::temp_dir().join(format!("huiyu-runtime-paths-{}",std::process::id()));
        let release=root.join("runtime-rs/target/release/huiyu-runtime.exe");
        fs::create_dir_all(release.parent().unwrap()).unwrap();fs::write(&release,b"fixture").unwrap();
        assert_eq!(select_dev_runtime(&root,None),release);
        let missing=root.join("not-built.exe");assert_eq!(select_dev_runtime(&root,Some(missing.clone())),missing);
        let relative=PathBuf::from("relative.exe");assert_eq!(select_dev_runtime(&root,Some(relative.clone())),relative);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrate_copies_electron_json_and_token() {
        let tmp = std::env::temp_dir().join(format!("aics-migrate-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let appdata = tmp.join("appdata");
        let source = appdata.join("ai-cg-studio");
        let state = source.join("gateway").join("runtime").join("state");
        fs::create_dir_all(&state).unwrap();
        fs::write(source.join("companion-window.json"), r#"{"x":10,"y":20,"width":540,"height":760}"#).unwrap();
        fs::write(state.join("gateway_token"), "tok-abc").unwrap();

        let config_root = tmp.join("config");
        let runtime_root = config_root.join("gateway");
        // 临时替换 APPDATA 以隔离测试
        let old = std::env::var("APPDATA").ok();
        unsafe { std::env::set_var("APPDATA", appdata.to_string_lossy().to_string()) };
        let migrated = migrate_electron_data(&config_root, &runtime_root);
        if let Some(old) = old { unsafe { std::env::set_var("APPDATA", old) } }

        assert!(migrated.contains(&"companion-window.json".to_string()));
        assert!(migrated.iter().any(|m| m.contains("gateway_token")));
        assert_eq!(
            fs::read_to_string(config_root.join("companion-window.json")).unwrap(),
            r#"{"x":10,"y":20,"width":540,"height":760}"#
        );
        assert_eq!(
            fs::read_to_string(runtime_root.join("runtime").join("state").join("gateway_token")).unwrap(),
            "tok-abc"
        );
        // 幂等：再跑一次不重复
        assert!(migrate_electron_data(&config_root, &runtime_root).is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }
}
