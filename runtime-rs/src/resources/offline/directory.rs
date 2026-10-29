use super::{
    Error, Options, Result, Value, catalog, config, fs, install, json, paths::Paths,
    release::Release,
};
use tokio_util::sync::CancellationToken;

pub(super) fn attach(
    options: &Options,
    paths: &Paths,
    release: &Release,
    cancel: &CancellationToken,
) -> Result<Value> {
    if release.baseline.is_some() {
        return Err(Error::new(
            "DIRECTORY_FULL_REQUIRED",
            "直接使用文件夹需要完整素材包；增量包请通过 ZIP 安装。",
        ));
    }
    if !options.apply {
        return Ok(
            json!({"ok":true,"kind":"huiyu-offline-directory-plan","packageMode":"full","releaseId":release.id,
            "files":release.files,"bytes":release.bytes,"runtimeRoot":options.runtime,
            "directoryRoot":options.package,"sourceType":"directory"}),
        );
    }
    if paths.pending.exists() {
        return Err(Error::new(
            "PENDING_TRANSACTION",
            "请先完成上次资源导入，再切换素材目录。",
        ));
    }
    let mut next = install::configuration(options, paths, release)?;
    next["directory"] = json!({"packageRoot":options.package,"releaseId":release.id,"identity":release.assets.identity(),
        "manifestSha256":super::super::digest(fs::bytes(&options.package.join("pack/manifest.json"), fs::MAX_JSON, false)?)});
    config::cancelled(cancel)?;
    let mut content = catalog::prepare(options, release)?;
    config::cancelled(cancel)?;
    let content = catalog::apply(options, release, &mut content)?;
    fs::ensure(&paths.user)?;
    fs::write_json(&paths.policy, &next)?;
    Ok(
        json!({"ok":true,"kind":"huiyu-offline-import-result","action":"directory-mounted","releaseId":release.id,
        "releaseSha256":options.expected,"directoryRoot":options.package,"catalog":content,"restartRequired":true}),
    )
}
