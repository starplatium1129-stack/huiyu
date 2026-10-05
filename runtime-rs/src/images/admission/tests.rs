use super::*;
use image::ImageEncoder;

#[derive(Clone, Copy)]
enum Fault {
    Write,
    Cancel,
}
tokio::task_local! {
    static FAULT: Fault;
    static SALT_FAULT: Fault;
}

pub(super) fn pending_file(
    file: tokio::fs::File,
    path: &Path,
    cancel: &CancellationToken,
) -> tokio::fs::File {
    match FAULT.try_with(|fault| *fault) {
        Ok(Fault::Write) => {
            drop(file);
            // A real read-only handle makes Tokio's queued write fail on flush,
            // without disk quotas, timing loops, or changing process permissions.
            std::fs::write(path, b"partial image").unwrap();
            tokio::fs::File::from_std(std::fs::File::open(path).unwrap())
        }
        Ok(Fault::Cancel) => {
            cancel.cancel();
            file
        }
        Err(_) => file,
    }
}

pub(super) fn salt_file(
    file: tokio::fs::File,
    path: &Path,
    cancel: &CancellationToken,
) -> tokio::fs::File {
    match SALT_FAULT.try_with(|fault| *fault) {
        Ok(Fault::Write) => {
            drop(file);
            tokio::fs::File::from_std(std::fs::File::open(path).unwrap())
        }
        Ok(Fault::Cancel) => {
            cancel.cancel();
            file
        }
        Err(_) => file,
    }
}
#[tokio::test]
async fn initial_salt_failure_does_not_poison_retry_or_replace_existing_identity() {
    for fault in [Fault::Write, Fault::Cancel] {
        let directory = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        assert!(
            SALT_FAULT
                .scope(fault, owner_salt(directory.path(), &cancel))
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        let cancel = CancellationToken::new();
        let salt = owner_salt(directory.path(), &cancel).await.unwrap();
        assert_eq!(salt.len(), 32);
        assert_eq!(owner_salt(directory.path(), &cancel).await.unwrap(), salt);
        let path = directory.path().join(".aics-image-owner-salt");
        std::fs::write(&path, b"invalid old identity").unwrap();
        assert_eq!(
            owner_salt(directory.path(), &cancel).await.unwrap(),
            b"invalid old identity"
        );
        assert_eq!(
            owner_matches_for(directory.path(), "any.png", b"bytes", "owner", Kind::Anima)
                .await
                .unwrap_err()
                .code,
            "IMAGE_STORAGE_INVALID"
        );
        assert_eq!(std::fs::read(path).unwrap(), b"invalid old identity");
    }
}

#[tokio::test]
async fn upload_write_failure_and_cancellation_do_not_publish_or_leave_pending_files() {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&[1, 2, 3], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    for kind in [Kind::Anima, Kind::VideoInput, Kind::VideoReference] {
        for fault in [Fault::Write, Fault::Cancel] {
            let temp = tempfile::tempdir().unwrap();
            let history = temp.path().join("user-original.png");
            std::fs::write(&history, &bytes).unwrap();
            let result = FAULT
                .scope(
                    fault,
                    store_for(
                        temp.path().to_owned(),
                        STANDARD.encode(&bytes),
                        "owner".into(),
                        Limits::default(),
                        CancellationToken::new(),
                        kind,
                    ),
                )
                .await;
            assert_eq!(
                result.unwrap_err().code,
                match fault {
                    Fault::Write => "STORAGE_UNAVAILABLE",
                    Fault::Cancel => "CANCELLED",
                }
            );
            assert_eq!(std::fs::read(&history).unwrap(), bytes);
            let mut entries: Vec<_> = std::fs::read_dir(temp.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            entries.sort();
            assert_eq!(
                entries,
                [".aics-image-owner-salt", "user-original.png"].map(std::ffi::OsString::from)
            );
        }
    }
}
