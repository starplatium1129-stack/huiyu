use super::*;

#[test]
fn facet_cache_survives_reopen_and_tracks_imports_and_cross_connection_edits() {
    let (_temp, options, mut writer) = fixture();
    let cache = FacetCache::default();
    let query = Query {
        kind: "scene".into(),
        page_size: Some(1),
        ..Default::default()
    };
    let read = |query: &Query| {
        Catalog::open(options.clone())
            .unwrap()
            .query_cached(query, Some(&cache))
            .unwrap()
    };
    let first = read(&query);
    assert_eq!(first, writer.query(&query).unwrap());
    let reopened = Catalog::open(options.clone()).unwrap();
    assert!(cache.select(&reopened, "scene").unwrap().1.is_some());
    let second_page = Query {
        page: Some(2),
        ..query
    };
    assert_eq!(read(&second_page)["facets"], first["facets"]);
    assert_eq!(read(&second_page)["total"], 2);

    let mut snapshot = writer.snapshot().unwrap();
    let record = snapshot["records"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|record| record["kind"] == "scene" && record["id"] == "sc002")
        .unwrap();
    record["data"]["category"] = json!("imported");
    writer.import(&snapshot, false).unwrap();
    let imported = read(&second_page);
    assert_eq!(imported["facets"]["categories"], json!(["imported"]));
    assert_ne!(imported["version"], first["version"]);

    let changes = [patch("scene", "sc002", 2, json!({"category":"edited"}))];
    writer.apply(&changes, true).unwrap();
    assert_eq!(
        read(&second_page),
        imported,
        "preview must not invalidate authority"
    );
    writer.apply(&changes, false).unwrap();
    let filtered = Query {
        search: "no matches".into(),
        ..second_page
    };
    let edited = read(&filtered);
    assert_eq!(edited["total"], 0);
    assert_eq!(edited["facets"]["categories"], json!(["edited"]));
    assert_eq!(edited, writer.query(&filtered).unwrap());
    let media = Query {
        kind: "media".into(),
        ..Default::default()
    };
    assert_eq!(read(&media), writer.query(&media).unwrap());

    // One owner can be reused after selecting another workspace with the same
    // revision number; database identity is part of the cache generation.
    let (_other_temp, _, other) = fixture();
    let other_page = other.query_cached(&filtered, Some(&cache)).unwrap();
    assert_eq!(other_page["facets"]["categories"], json!([]));
    assert_eq!(read(&filtered), edited);
    drop(reopened);
    drop(writer);
    std::fs::remove_file(&options.database).unwrap();
    assert_eq!(
        Catalog::open(options).err().unwrap().code,
        "CATALOG_MISSING"
    );
}
