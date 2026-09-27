#[path = "../src/interrogate/preprocess.rs"]
mod preprocess;
#[path = "../src/native_images/api.rs"]
#[allow(
    dead_code,
    reason = "Pixel parity uses the WD14 subset of the shared private image FFI table"
)]
mod vips_api;

#[test]
#[ignore = "Requires explicit generated neutral fixture directory and selected libvips DLL"]
fn sharp_neutral_pixel_parity() {
    let root = std::path::PathBuf::from(
        std::env::var_os("AICS_TEST_INTERROGATE_PIXELS").expect("explicit fixture root"),
    );
    let library = std::path::PathBuf::from(
        std::env::var_os("AICS_TEST_VIPS_DLL").expect("explicit libvips DLL"),
    );
    let records: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("manifest.json")).unwrap()).unwrap();
    let mut failed = Vec::new();
    for record in records.as_array().unwrap() {
        let source = std::fs::read(root.join(record["source"].as_str().unwrap())).unwrap();
        let expected = std::fs::read(root.join(record["expected"].as_str().unwrap())).unwrap();
        let actual = preprocess::rgb(
            &source,
            &library,
            &tokio_util::sync::CancellationToken::new(),
        )
        .unwrap();
        let mismatches = actual.iter().zip(&expected).filter(|(a, b)| a != b).count();
        let maximum = actual
            .iter()
            .zip(&expected)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .unwrap_or(0);
        eprintln!(
            "{}: bytes={} differences={} max_error={}",
            record["name"],
            actual.len(),
            mismatches,
            maximum
        );
        if actual.len() != expected.len() || mismatches != 0 {
            failed.push(record["name"].clone());
        }
        let tensor = preprocess::bgr(actual);
        assert_eq!(tensor.len(), 448 * 448 * 3);
    }
    assert!(failed.is_empty(), "Pixel parity differs for {failed:?}");
}
#[path = "../src/native_images/library.rs"]
mod library;
