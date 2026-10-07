use super::*;

#[test]
fn encoded_projection_reuses_bytes_and_tracks_committed_authority() {
    let (_temp, options, mut catalog) = fixture();
    let cache = ProjectionCache::default();
    let read = || cache.read(options.clone(), "scenes.json").unwrap().unwrap();
    let first = read();
    assert_eq!(
        first.as_ref(),
        serde_json::to_vec(&catalog.projection("scenes.json").unwrap().unwrap()).unwrap()
    );
    assert_eq!(first.as_ptr(), read().as_ptr());

    let changes = [patch("scene", "sc002", 1, json!({"story":"Updated room."}))];
    catalog.apply(&changes, true).unwrap();
    assert_eq!(first.as_ptr(), read().as_ptr(), "preview is not a commit");
    catalog.apply(&changes, false).unwrap();
    let updated = read();
    assert_eq!(
        serde_json::from_slice::<Value>(&updated).unwrap()[1]["story"],
        "Updated room."
    );
    assert_eq!(updated.as_ptr(), read().as_ptr());

    drop(catalog);
    std::fs::remove_file(&options.database).unwrap();
    assert_eq!(
        cache.read(options, "scenes.json").unwrap_err().code,
        "CATALOG_MISSING",
        "cached content must not mask a missing authority"
    );
}
