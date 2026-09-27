use crate::error::{ApiError, Result};
mod token;
use serde_json::Value;
use std::{
    env,
    net::SocketAddr,
    path::{Component, PathBuf},
};

#[derive(Clone, Debug)]
pub struct Config {
    pub app_root: PathBuf,
    pub runtime_root: PathBuf,
    pub ai_workspace_root: PathBuf,
    pub sd_host: String,
    pub sd_auth: Option<String>,
    pub comfy_host: String,
    pub bind: SocketAddr,
    pub token: String,
    pub desktop_secret: Option<String>,
    pub source_profile_id: Option<String>,
    pub workspace_pointer: Option<Value>,
    pub workspace_candidate: Option<Value>,
    pub config_root: Option<PathBuf>,
    pub gateway_origin: String,
    pub workspace_root: Option<PathBuf>,
    pub workspace_id: Option<String>,
    pub create_workspace: bool,
}

impl Config {
    pub fn tools_root(&self) -> PathBuf {
        let path = env::var_os("AICS_TOOLS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.app_root.join("tools"));
        if path.is_absolute() {
            path
        } else {
            env::current_dir()
                .unwrap_or_else(|_| self.app_root.clone())
                .join(path)
        }
    }
    pub fn assets_root(&self) -> PathBuf {
        let path = env::var_os("AICS_ASSETS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| self.app_root.join("assets"));
        if path.is_absolute() {
            path
        } else {
            env::current_dir()
                .unwrap_or_else(|_| self.app_root.clone())
                .join(path)
        }
    }
    pub fn from_env() -> Result<Self> {
        let mut root = env::var_os("AICS_APP_ROOT")
            .map(PathBuf::from)
            .unwrap_or(env::current_dir()?);
        let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let host = if host == "localhost" {
            "127.0.0.1"
        } else {
            host.as_str()
        };
        let port = env::var("PORT")
            .ok()
            .map(|value| value.parse::<u16>())
            .transpose()
            .map_err(|_| ApiError::invalid("Invalid PORT"))?
            .unwrap_or(3000);
        let mut bind = SocketAddr::new(
            host.parse()
                .map_err(|_| ApiError::invalid("Invalid HOST"))?,
            port,
        );
        let mut workspace_root = None;
        let mut workspace_id = None;
        let mut create_workspace = false;
        let mut args = env::args().skip(1);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--app-root" => {
                    root = args
                        .next()
                        .ok_or_else(|| ApiError::invalid("--app-root requires a path"))?
                        .into()
                }
                "--bind" => {
                    bind = args
                        .next()
                        .ok_or_else(|| ApiError::invalid("--bind requires IP:port"))?
                        .parse()
                        .map_err(|_| ApiError::invalid("Invalid bind address"))?
                }
                "--workspace-root" => {
                    workspace_root =
                        Some(PathBuf::from(args.next().ok_or_else(|| {
                            ApiError::invalid("--workspace-root requires a path")
                        })?))
                }
                "--workspace-id" => {
                    workspace_id =
                        Some(args.next().ok_or_else(|| {
                            ApiError::invalid("--workspace-id requires an identity")
                        })?)
                }
                "--create-workspace" => create_workspace = true,
                _ => return Err(ApiError::invalid(format!("Unknown argument: {arg}"))),
            }
        }
        let app_root = root.canonicalize()?;
        let runtime_root = env::var_os("AICS_RUNTIME_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| app_root.join("runtime"));
        let ai_workspace_root = env::var_os("AI_WORKSPACE_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| app_root.parent().unwrap_or(&app_root).join("AI"));
        let runtime_root = if runtime_root.is_absolute() {
            runtime_root
        } else {
            env::current_dir()?.join(runtime_root)
        };
        let ai_workspace_root = if ai_workspace_root.is_absolute() {
            ai_workspace_root
        } else {
            env::current_dir()?.join(ai_workspace_root)
        };
        let saved: Value = std::fs::read(runtime_root.join("config.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or(Value::Null);
        let sd_host = upstream_host("SD_HOST", &saved["sdHost"], "http://127.0.0.1:7860");
        let comfy_host = upstream_host("COMFY_HOST", &saved["comfyHost"], "http://127.0.0.1:8188");
        let desktop_secret = env::var("AICS_DESKTOP_GATEWAY_TOKEN").ok();
        let source_profile_id = env::var("AICS_DESKTOP_SOURCE_PROFILE_ID").ok();
        if desktop_secret.is_some() != source_profile_id.is_some() {
            return Err(ApiError::invalid(
                "Desktop secret and source profile must be provided together",
            ));
        }
        if desktop_secret.as_ref().is_some_and(|s| {
            s.len() != 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(ApiError::invalid("Invalid desktop host secret"));
        }
        let mut workspace_pointer = None;
        let mut workspace_candidate = None;
        let config_root = env::var_os("AICS_DESKTOP_CONFIG_ROOT").map(PathBuf::from);
        if workspace_root.is_some() != workspace_id.is_some() {
            return Err(ApiError::invalid(
                "Workspace path and identity must be provided together",
            ));
        }
        // Opening a production pointer is always explicit. The candidate never
        // searches APPDATA or silently adopts an installed user's workspace.
        if let Some(config_root) = &config_root {
            if workspace_root.is_some() || desktop_secret.is_none() {
                return Err(ApiError::invalid(
                    "Desktop config requires host identity and excludes explicit workspace options",
                ));
            }
            if !config_root.is_absolute()
                || config_root
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err(ApiError::invalid(
                    "Desktop config root must be absolute without parent traversal",
                ));
            }
            let active = config_root.join("workspace-active.json");
            let candidate = config_root.join("workspace-candidate.json");
            let is_active = active.exists();
            let selected = if is_active { active } else { candidate };
            if selected.exists() {
                let pointer: Value = serde_json::from_slice(&std::fs::read(selected)?)?;
                let id = pointer
                    .get("workspaceId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApiError::invalid("Workspace pointer has no identity"))?;
                if !valid_pointer(&pointer) {
                    return Err(ApiError::invalid("Invalid workspace pointer"));
                }
                workspace_root = Some(config_root.join("workspaces").join(id));
                workspace_id = Some(id.into());
                if is_active {
                    workspace_pointer = Some(pointer);
                } else {
                    workspace_candidate = Some(pointer);
                }
            }
        }
        if create_workspace && workspace_root.is_none() {
            return Err(ApiError::invalid(
                "Creating a fixture requires explicit workspace options",
            ));
        }
        for path in workspace_root.iter().chain(config_root.iter()) {
            if !path.is_absolute()
                || path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir))
            {
                return Err(ApiError::invalid(
                    "Workspace path must be absolute without parent traversal",
                ));
            }
            // A private store cannot become part of publicly served application assets.
            let existing = path
                .ancestors()
                .find(|p| p.exists())
                .ok_or_else(|| ApiError::invalid("Workspace parent unavailable"))?
                .canonicalize()?;
            if existing.starts_with(&app_root) {
                return Err(ApiError::invalid(
                    "Workspace must be outside the application tree",
                ));
            }
        }
        let token = token::load(&runtime_root, env::var("TOKEN").ok().as_deref())?;
        Ok(Self {
            app_root,
            runtime_root,
            ai_workspace_root,
            sd_host,
            sd_auth: env::var("SD_API_AUTH")
                .ok()
                .filter(|value| !value.is_empty()),
            comfy_host,
            bind,
            gateway_origin: format!("http://{bind}"),
            token,
            desktop_secret,
            source_profile_id,
            workspace_pointer,
            workspace_candidate,
            config_root,
            workspace_root,
            workspace_id,
            create_workspace,
        })
    }
}

fn upstream_host(key: &str, saved: &Value, fallback: &str) -> String {
    [
        env::var(key).ok(),
        saved.as_str().map(str::to_string),
        Some(fallback.into()),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| {
        crate::upstream::local_url(&value)
            .ok()
            .and_then(|_| url::Url::parse(&value).ok())
            .map(|url| url.origin().ascii_serialization())
    })
    .unwrap_or_else(|| fallback.into())
}

fn valid_pointer(pointer: &Value) -> bool {
    let Some(id) = pointer["workspaceId"].as_str() else {
        return false;
    };
    let Some(domains) = pointer["domains"].as_array() else {
        return false;
    };
    let required = ["artwork", "settings", "chat", "draft"];
    uuid::Uuid::parse_str(id).is_ok()
        && id.len() == 36
        && id == id.to_ascii_lowercase()
        && pointer["formatVersion"] == 1
        && pointer["bundledUi"].is_boolean()
        && pointer["generation"]
            .as_u64()
            .is_some_and(|v| (1..=9_007_199_254_740_991).contains(&v))
        && pointer["activatedRevision"]
            .as_u64()
            .is_some_and(|v| v <= 9_007_199_254_740_991)
        && domains
            .iter()
            .all(|value| value.as_str().is_some_and(|s| required.contains(&s)))
        && (pointer["bundledUi"] != true
            || required
                .iter()
                .all(|domain| domains.contains(&Value::from(*domain))))
}
