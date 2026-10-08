use super::*;

#[test]
fn encoded_projection_reuses_bytes_and_tracks_committed_authority() {
    let (_temp, options, mut catalog) = fixture();
    let cache = ProjectionCache::default();
    let read = || {
        cache
            .read(options.clone(), "scenes.json")
            .unwrap()
            .unwrap()
            .bytes
    };
    let first_tag = cache
        .read(options.clone(), "scenes.json")
        .unwrap()
        .unwrap()
        .tag;
    let first = read();
    assert_eq!(
        first.as_ref(),
        serde_json::to_vec(&catalog.projection("scenes.json").unwrap().unwrap()).unwrap()
    );
    assert_eq!(first.as_ptr(), read().as_ptr());

    let changes = [patch(
        "scene",
        "sc002",
        1,
        json!({"story":"Updated room.","extension":{"stressText":"x".repeat(2*1024*1024)}}),
    )];
    catalog.apply(&changes, true).unwrap();
    assert_eq!(first.as_ptr(), read().as_ptr(), "preview is not a commit");
    catalog.apply(&changes, false).unwrap();
    let barrier = std::sync::Barrier::new(4);
    let responses = std::thread::scope(|scope| {
        let readers = (0..4)
            .map(|_| {
                let (cache, barrier, options) = (&cache, &barrier, options.clone());
                scope.spawn(move || {
                    barrier.wait();
                    cache.read(options, "scenes.json").unwrap().unwrap()
                })
            })
            .collect::<Vec<_>>();
        readers
            .into_iter()
            .map(|reader| reader.join().unwrap())
            .collect::<Vec<_>>()
    });
    let updated = responses[0].bytes.clone();
    assert!(
        responses
            .iter()
            .all(|value| value.bytes.as_ptr() == updated.as_ptr()),
        "concurrent cold reads must share one encoded allocation"
    );
    assert_ne!(responses[0].tag, first_tag);
    assert!(responses.iter().all(|value| value.tag == responses[0].tag));
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
