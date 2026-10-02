use super::*;

#[test]
fn repeated_import_rejects_unreadable_showcase_without_overwriting_local_data() {
    let temp = directory();
    let options = fixture(temp.path(), "release_a", &["sc1000"]);
    apply(&options);
    let root = show(&options);
    let paths = paths::Paths::new(&options).unwrap();
    let policy = std::fs::read(&paths.policy).unwrap();
    let pointer = std::fs::read(paths.showcase.join("active.json")).unwrap();
    let original = std::fs::read(root.join("manifest.json")).unwrap();
    for (name, code, directory) in [
        ("images/sc1000.jpg", "CONTENT_INVALID", false),
        ("thumbs/sc1000.jpg", "CONTENT_INVALID", false),
        ("thumbs/sc1000.jpg", "CONTENT_INVALID", true),
        ("manifest.json", "METADATA_INVALID", false),
    ] {
        let file = root.join(name);
        let bytes = std::fs::read(&file).unwrap();
        if name == "manifest.json" {
            std::fs::write(&file, b"{broken").unwrap();
        } else {
            std::fs::remove_file(&file).unwrap();
            if directory {
                std::fs::create_dir(&file).unwrap();
            }
        }
        for apply in [false, true] {
            let error = execute(
                &Options {
                    apply,
                    ..options.clone()
                },
                &CancellationToken::new(),
            )
            .unwrap_err();
            assert_eq!(error.code, code);
            assert!(error.message.contains(name));
            assert_eq!(std::fs::read(&paths.policy).unwrap(), policy);
            assert_eq!(
                std::fs::read(paths.showcase.join("active.json")).unwrap(),
                pointer
            );
            assert!(!paths.pending.exists());
            if name != "manifest.json" {
                assert!(!file.is_file());
                assert_eq!(file.is_dir(), directory);
                assert_eq!(std::fs::read(root.join("manifest.json")).unwrap(), original);
            } else {
                assert_eq!(std::fs::read(&file).unwrap(), b"{broken");
            }
        }
        if directory {
            std::fs::remove_dir(&file).unwrap();
        }
        std::fs::write(&file, bytes).unwrap();
    }
    assert_eq!(apply(&options)["action"], "already-installed");
}
