use std::path::{Path, PathBuf};

use tauri::Manager;

/// dev 模式项目根：desktop-tauri/src-tauri 上两级 = 仓库根
pub const DEV_PROJECT_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

#[derive(Clone)]
pub struct DesktopPaths {
    pub app_root: PathBuf,
    #[allow(dead_code)]
    pub resource_root: PathBuf,
    pub gateway_script: PathBuf,
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
    pub sidecar_node: Option<PathBuf>,
}

fn first_existing(candidates: &[PathBuf]) -> PathBuf {
    candidates
        .iter()
        .find(|c| c.exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

/// 去掉 Windows `\\?\` UNC 前缀（std::fs::canonicalize 会引入；node 等
/// 外部程序解析 `\\?\C:` 会失败）。
fn simplify_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

/// 打包模式：resource_dir 下有 gateway/server.js 即为 packaged；
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

    // 诊断：resource_dir 与候选布局（打包模式资源在 exe 旁 resources/ 下）
    let _packaged_gateway_candidates = [
        resource_root.join("gateway").join("server.js"),
        resource_root
            .parent()
            .unwrap_or(&resource_root)
            .join("resources")
            .join("gateway")
            .join("server.js"),
    ];
    // Windows 打包布局：resource_dir() = exe 目录，NSIS 把资源平铺到安装根
    // （gateway/、node.exe）；手动布局（本机解包测试）在 exe 旁 resources/ 下。
    // dev 模式（cargo run）resource_dir = target/debug——tauri 会把打包资源
    // 复制进 target 目录，必须排除，否则 dev 被误判为 packaged。
    let resources_dir = resource_root.join("resources");
    let gateway_dir = first_existing(&[
        resource_root.join("gateway"),
        resources_dir.join("gateway"),
    ]);
    let is_cargo_target = resource_root
        .file_name()
        .map(|n| {
            let n = n.to_string_lossy();
            (n == "debug" || n == "release")
                && resource_root
                    .parent()
                    .and_then(|p| p.file_name())
                    .map(|p| p.to_string_lossy() == "target")
                    .unwrap_or(false)
        })
        .unwrap_or(false);
    let is_packaged = !is_cargo_target && gateway_dir.join("server.js").exists();

    let (app_root, gateway_script) = if is_packaged {
        // 打包布局：网关代码根（相当于 Electron 的 asar 根，ROOT_DIR 语义 =
        // 含 dist/assets/tools/data 的网关根）
        let script = gateway_dir.join("server.js");
        (gateway_dir.clone(), script)
    } else {
        let root = PathBuf::from(DEV_PROJECT_ROOT);
        (root.clone(), root.join("server.js"))
    };

    let gateway_cwd = gateway_script.parent().unwrap_or(&app_root).to_path_buf();
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

    // sidecar node：NSIS 安装布局在安装根 node.exe（externalBin 重命名）；
    // 手动/开发布局在 resource_root/binaries/node-<triple>.exe
    let sidecar_node = if is_packaged {
        first_existing(&[
            resource_root.join("node.exe"),
            resource_root.join("binaries").join("node-x86_64-pc-windows-msvc.exe"),
        ])
        .into()
    } else {
        None
    };

    let profile_root = crate::ui_entry::isolated_profile().unwrap_or_else(|| app.path().app_local_data_dir().expect("WebView profile directory is unavailable"));
    // Failure retains a closed migration boundary; it does not invent a new
    // identity for unreadable data. The bundled UI can still show diagnostics.
    let source_profile_id = crate::gateway::profile_id(&profile_root).unwrap_or_default();
    DesktopPaths {
        app_root,
        resource_root,
        gateway_script,
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
        sidecar_node,
    }
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
