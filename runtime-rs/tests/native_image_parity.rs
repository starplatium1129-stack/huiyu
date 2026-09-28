#[path = "../src/native_images/api.rs"]
#[allow(
    dead_code,
    reason = "Atlas and thumbnail parity use their subset of the shared private image FFI table"
)]
mod api;
#[path = "../src/native_images/library.rs"]
mod library;
#[path = "../src/native_images/transform.rs"]
mod transform;

#[test]
#[ignore = "Requires explicitly generated neutral sharp fixtures and libvips DLL"]
fn derived_atlases_and_thumbnails_match_sharp_bytes() {
    let root = std::path::PathBuf::from(
        std::env::var_os("AICS_TEST_INTERROGATE_PIXELS").expect("fixture root"),
    );
    let library = std::path::PathBuf::from(
        std::env::var_os("AICS_TEST_VIPS_DLL").expect("selected libvips DLL"),
    );
    let records: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut failed = Vec::new();
    for record in records.as_array().unwrap() {
        let path = root.join(record["source"].as_str().unwrap());
        let name = record["name"].as_str().unwrap();
        for (kind, scale) in [
            ("standard", Some(2)),
            ("compact", Some(4)),
            ("thumbnail", None),
        ] {
            let actual = match scale {
                Some(scale) => transform::atlas(&path, &library, scale, &cancel).unwrap(),
                None => transform::thumbnail(&path, &library, &cancel)
                    .unwrap()
                    .unwrap(),
            };
            let expected = std::fs::read(root.join(format!("{name}.{kind}"))).unwrap();
            eprintln!(
                "{name}/{kind}: actual={} expected={} byte_equal={}",
                actual.len(),
                expected.len(),
                actual == expected
            );
            if actual != expected {
                std::fs::write(root.join(format!("{name}.{kind}.actual")), actual).unwrap();
                failed.push(format!("{name}/{kind}"));
            }
        }
    }
    assert!(
        failed.is_empty(),
        "Sharp derived byte parity differs: {failed:?}"
    );
}
