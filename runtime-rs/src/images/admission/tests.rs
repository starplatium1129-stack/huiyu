use super::*;
use image::ImageEncoder;

#[derive(Clone, Copy)]
enum Fault {
    Write,
    Cancel,
}
tokio::task_local! {
    static FAULT: Fault;
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
