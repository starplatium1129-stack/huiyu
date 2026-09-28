use super::*;
use std::fs;

fn write(path: &FsPath, value: &Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

#[test]
fn source_shards_are_authoritative_and_read_only() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    write(
        &root.join("data/references/manifest.json"),
        &json!({"version":1,"standards":{"perspectives":[]},"characterIds":["nene"],"viewOrder":["nene"]}),
    );
    let profile = json!({"characterId":"nene","outfits":[{"outfitId":"one","references":[{"pending":true}]}]});
    write(
        &root.join("data/references/nene.json"),
        &json!({"standard":{"id":"nene","outfits":[]},"view":profile}),
    );
    write(
        &root.join("data/character-reference-view.json"),
        &json!({"nene":{"stale":true}}),
    );
    let mut reader = Reader::new(root.into(), None);
    assert_eq!(reader.read(Some("nene")).unwrap(), Some(profile.clone()));
    assert_eq!(reader.read(Some("unknown")).unwrap(), None);
    assert_eq!(reader.read(None).unwrap(), Some(json!({"nene":profile})));
    assert_eq!(
        io::json(&root.join("data/character-reference-view.json")).unwrap(),
        json!({"nene":{"stale":true}})
    );
    let mut unavailable = Reader::new(root.into(), Some(root.join("missing-explicit-library")));
    assert_eq!(
        unavailable.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
}

fn published_fixture(root: &FsPath) -> PathBuf {
    let directory = root.join("published");
    fs::create_dir_all(directory.join("nene/outfit")).unwrap();
    let image = b"isolated integrity fixture";
    fs::write(directory.join("nene/outfit/front.png"), image).unwrap();
    let view = json!({"nene":{"characterId":"nene","outfits":[{"references":[{"url":"/character-references/nene/outfit/front.png","pending":false}]}]}});
    write(&root.join("data/character-reference-view.json"), &view);
    write(
        &root.join("data/character-reference-standards.json"),
        &json!({"characters":[]}),
    );
    write(&directory.join("character-reference-view.json"), &view);
    let mut manifest = json!({"schemaVersion":1,"kind":"reference-release",
        "files":[{"path":"nene/outfit/front.png","bytes":image.len(),"sha256":io::digest(image)}],
        "viewSha256":io::digest(io::bytes(&directory.join("character-reference-view.json")).unwrap()),
        "sourceStandardsSha256":io::digest(io::bytes(&root.join("data/character-reference-standards.json")).unwrap()),
        "sourceViewSha256":io::digest(io::bytes(&root.join("data/character-reference-view.json")).unwrap()),
        "candidateManifestSha256":"fixture","reviewSha256":"fixture","baseIdentity":"fixture","approvals":[]});
    manifest["identity"] = release::seal(&manifest).into();
    write(&directory.join("reference-release.json"), &manifest);
    directory
}

#[test]
fn published_profiles_revoke_without_legacy_fallback() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path();
    let directory = published_fixture(root);
    let mut reader = Reader::new(root.into(), Some(directory.clone()));
    assert!(reader.read(Some("nene")).unwrap().is_some());
    assert!(reader.read(None).unwrap().is_some());
    match reader.asset("nene/outfit/front.png").unwrap() {
        assets::Asset::Published(bytes, _) => assert_eq!(bytes, b"isolated integrity fixture"),
        _ => panic!("sealed reference did not resolve its published image"),
    }
    fs::write(directory.join("reference-release.json"), b"{}").unwrap();
    assert_eq!(
        reader.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    assert_eq!(
        reader.read(None).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    let directory = published_fixture(root);
    let mut reader = Reader::new(root.into(), Some(directory.clone()));
    fs::write(directory.join("nene/outfit/front.png"), b"changed").unwrap();
    assert_eq!(
        reader.asset("nene/outfit/front.png").unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    assert_eq!(
        reader.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
    let mut changed = Reader::new(root.into(), Some(directory));
    assert_eq!(
        changed.read(Some("nene")).unwrap_err().code,
        "REFERENCE_RELEASE_INVALID"
    );
}

#[test]
fn linked_reference_files_are_rejected() {
    let fixture = tempfile::tempdir().unwrap();
    let original = fixture.path().join("original.json");
    let alias = fixture.path().join("alias.json");
    fs::write(&original, b"{}").unwrap();
    fs::hard_link(&original, &alias).unwrap();
    assert!(io::bytes(&alias).is_err());
}
