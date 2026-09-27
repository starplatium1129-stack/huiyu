use super::{Error, Result, codec, fs};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const VERSIONED_FILES: &[&str] = &[
    "scenes.json",
    "scenes-index.json",
    "scenes-core.json",
    "scenes-nene.json",
    "scenes-natsume.json",
    "scenes-shared.json",
    "curation.json",
    "characters.json",
    "loras.json",
    "tags.json",
    "presets.json",
    "popular-characters.json",
    "scene-blueprints.json",
];
#[derive(Clone)]
pub struct Options {
    pub root: PathBuf,
    pub runtime: PathBuf,
    pub showcase: Option<PathBuf>,
}
#[derive(Clone)]
pub(super) struct Context {
    pub options: Options,
    pub root_identity: Value,
    pub state: PathBuf,
    pub lease: PathBuf,
    pub backup: PathBuf,
}
impl Context {
    pub fn new(options: &Options) -> Result<Self> {
        let options = Options {
            root: fs::absolute(&options.root)?,
            runtime: fs::absolute(&options.runtime)?,
            showcase: options
                .showcase
                .as_ref()
                .map(|path| fs::absolute(path))
                .transpose()?,
        };
        let root_identity = fs::directory_identity(&options.root)?;
        if fs::same(&options.root, &options.runtime)
            || options.runtime.parent().is_none()
            || ["data", "src", ".git"].iter().any(|part| {
                let path = options.root.join(part);
                fs::same(&path, &options.runtime) || fs::within(&path, &options.runtime)
            })
        {
            return Err(Error::path("runtime 必须是独立目录"));
        }
        fs::safe(&options.runtime, true, true)?;
        let state = options.root.join("runtime/maintenance-transactions");
        fs::safe(&state, true, true)?;
        if let Some(showcase) = &options.showcase {
            fs::safe(showcase, true, false)?;
            if fs::same(showcase, &options.root)
                || fs::within(showcase, &options.root)
                || ["data", "src", ".git", "runtime"].iter().any(|part| {
                    let path = options.root.join(part);
                    fs::same(&path, showcase) || fs::within(&path, showcase)
                })
                || fs::same(showcase, &options.runtime)
                || fs::within(showcase, &options.runtime)
                || fs::within(&options.runtime, showcase)
            {
                return Err(Error::path("样张根与受保护范围重叠"));
            }
        }
        Ok(Self {
            lease: state.join("lease"),
            backup: options.runtime.join("maintenance-backups"),
            options,
            root_identity,
            state,
        })
    }
    pub fn target(&self, source: &Path) -> Result<PathBuf> {
        if !source.is_absolute() {
            return Err(Error::path("备份 source 必须是绝对路径"));
        }
        let path = fs::absolute(source)?;
        if fs::within(&self.options.root, &path) {
            let relative = path
                .strip_prefix(&self.options.root)
                .map_err(|_| Error::path("目标根不匹配"))?
                .to_string_lossy()
                .replace('\\', "/");
            let stem = relative
                .strip_suffix(".gz")
                .or_else(|| relative.strip_suffix(".br"))
                .unwrap_or(&relative);
            let data = stem.strip_prefix("data/").is_some_and(|name| {
                VERSIONED_FILES.contains(&name)
                    || [
                        "retired-scenes.json",
                        "character-reference-standards.json",
                        "character-reference-view.json",
                        "tags-dictionary.json",
                    ]
                    .contains(&name)
                    || name.split_once('/').is_some_and(|(folder, file)| {
                        ["scenes", "blueprints", "popular", "references"].contains(&folder)
                            && safe_name(file)
                    })
            });
            let tag_manifest_companion = stem == "data/tags/manifest.json" && stem != relative;
            if data || tag_manifest_companion || relative == "src/stores/sceneStore.ts" {
                fs::safe(&path, false, true)?;
                return Ok(path);
            }
        }
        if let Some(root) = &self.options.showcase
            && fs::within(root, &path)
        {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| Error::path("样张根不匹配"))?
                .to_string_lossy()
                .replace('\\', "/");
            let allowed = ["manifest.json", "home-hero.json"].contains(&relative.as_str())
                || relative.split_once('/').is_some_and(|(folder, file)| {
                    ["images", "thumbs", "home"].contains(&folder)
                        && file.rsplit_once('.').is_some_and(|(name, ext)| {
                            !name.is_empty()
                                && name
                                    .bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                                && ["jpg", "png", "webp"].contains(&ext)
                        })
                });
            if allowed {
                fs::safe(&path, false, true)?;
                return Ok(path);
            }
        }
        Err(Error::new(
            409,
            "MAINTENANCE_UNSUPPORTED_SCOPE",
            "未授权的恢复范围；外部样张必须显式配置 showcaseRoot",
        ))
    }
    pub fn key(&self, create: bool) -> Result<Vec<u8>> {
        let path = self.state.join("key");
        if create {
            fs::ensure(&self.state)?;
            if fs::safe(&path, false, true)?.is_none() {
                use std::io::Write;
                let mut options = std::fs::OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                match options.open(&path) {
                    Ok(mut file) => {
                        let mut entropy = Sha256::new();
                        for _ in 0..3 {
                            entropy.update(uuid::Uuid::new_v4().as_bytes());
                        }
                        file.write_all(&entropy.finalize())?;
                        file.sync_all()?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error.into()),
                }
            }
        }
        let key = fs::read(&path, false)?.unwrap();
        if key.len() != 32 {
            return Err(Error::journal("维护签名密钥不完整，拒绝恢复"));
        }
        Ok(key)
    }
    pub fn read_signed(&self, path: &Path) -> Result<Value> {
        codec::unseal(fs::json(path)?, &self.key(false)?)
    }
    pub fn write_signed(&self, path: &Path, value: Value) -> Result<()> {
        fs::write_json(path, &codec::seal(value, &self.key(false)?))
    }
}
pub(super) fn safe_name(name: &str) -> bool {
    name.ends_with(".json")
        && name
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}
