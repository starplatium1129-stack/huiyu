use super::*;
use crate::storage::verified_media::{self, Verified};
use std::fs;

pub(super) fn run(identity: &Identity, id: &str, media: &[Value], job: Option<&crate::workspace_jobs::Job>) -> Result<Outcome> {
    identity.check_paths()?;
    let mut outcome = Outcome {
        proofs: Vec::with_capacity(media.len()),
        blockers: Vec::new(),
    };
    let total = media.len() as u64;
    for (index,media) in media.iter().enumerate() {
        if let Some(job) = job { job.progress("verifying-media",index as u64,total); }
        identity.cancelled()?;
        let alias = string(media, "alias")?;
        match publish(identity, &key(id, alias), media) {
            Ok(proof) => outcome.proofs.push(Some(proof.into_stamp())),
            Err(error) if error.code == "CANCELLED" => return Err(error),
            Err(_) => {
                outcome.proofs.push(None);
                outcome.blockers.push(format!("media:{alias}"));
            }
        }
    }
    identity.check_paths()?;
    Ok(outcome)
}

fn publish(identity: &Identity, key: &str, media: &Value) -> Result<Verified> {
    media::validate(media)?;
    let destination = media::object_path(&identity.root, string(media, "sha256")?)?;
    if destination.try_exists()? {
        media::sync_checked(&identity.root, &destination, || identity.cancelled())?;
        return verified_media::verify(identity, &destination, media);
    }
    let staged = media::staging_path(&identity.root, key, string(media, "alias")?)?;
    media::sync_checked(&identity.root, &staged, || identity.cancelled())?;
    let proof = verified_media::verify(identity, &staged, media)?;
    fs::create_dir_all(destination.parent().unwrap())?;
    identity.check_paths()?;
    proof.check(&identity.root)?;
    match fs::hard_link(&staged, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            media::sync_checked(&identity.root, &destination, || identity.cancelled())?;
        }
        Err(error) => return Err(error.into()),
    }
    schema::sync_dir(destination.parent().unwrap())?;
    // Preserve staging on success, failure and cancellation. Removing a source
    // hard link would invalidate stored links/ChangeTime and lose retry bytes.
    // Publishing changed those fields too, so hash the final object again.
    drop(proof);
    identity.check_paths()?;
    verified_media::verify(identity, &destination, media)
}
