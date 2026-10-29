//! Locally selected full packages are read in place. Only their small manifest
//! is read at startup; assets are streamed directly when requested.
use super::{
    Error, Result, fs,
    manifest::Manifest,
    resolve::{self, Snapshot},
};
use serde::Deserialize;
use std::{collections::HashMap, path::PathBuf};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Registration {
    pub package_root: PathBuf,
    pub release_id: String,
    pub identity: String,
    pub manifest_sha256: String,
}
impl Registration {
    pub fn snapshot(&self, cancel: &CancellationToken) -> Result<Snapshot> {
        super::config::cancelled(cancel)?;
        if !self.package_root.is_absolute()
            || !super::identifier(&self.release_id)
            || !super::hash(&self.identity)
            || !super::hash(&self.manifest_sha256)
        {
            return Err(Error::new(
                "CONFIG_REQUIRED",
                "Invalid resource directory registration",
            ));
        }
        let root = self.package_root.join("pack");
        let raw = fs::bytes(&root.join("manifest.json"), fs::MAX_JSON, false)?;
        if super::digest(&raw) != self.manifest_sha256 {
            return Err(Error::new(
                "CONTENT_INVALID",
                "资源目录清单已变化，请重新选择文件夹。",
            ));
        }
        let manifest = Manifest::parse(
            &serde_json::from_slice(&raw)
                .map_err(|_| Error::new("CONTENT_INVALID", "Invalid directory manifest JSON"))?,
        )?;
        if manifest.identity() != self.identity {
            return Err(Error::new("CONTENT_INVALID", "资源目录版本与清单不一致。"));
        }
        let entries = manifest
            .entries
            .into_iter()
            .filter(|entry| resolve::serviceable(&entry.path))
            .map(|entry| (entry.path.clone(), entry))
            .collect::<HashMap<_, _>>();
        Ok(Snapshot {
            root,
            identity: self.identity.clone(),
            sequence: 0,
            release_id: self.release_id.clone(),
            previous: false,
            files: entries.len(),
            entries,
        })
    }
    pub fn mounted(&self, snapshot: &Snapshot) -> Result<()> {
        if snapshot.root != self.package_root.join("pack") || snapshot.identity != self.identity {
            return Err(Error::new(
                "STATE_CONFLICT",
                "Resource directory selection changed",
            ));
        }
        fs::safe(&snapshot.root, false, false)?;
        Ok(())
    }
}
