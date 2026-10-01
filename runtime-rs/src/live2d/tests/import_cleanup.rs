use super::*;

#[tokio::test]
async fn failed_import_cleans_only_its_owned_upload_directory() {
    let (_directory, service, app) = fixture();
    let retained = service.local.join(".editor-upload-existing");
    fs::create_dir_all(&retained).unwrap();
    fs::write(retained.join("keep.txt"), b"existing fixture").unwrap();
    let mut body = multipart();
    body.truncate(body.len() - b"--fixture-boundary--\r\n".len());
    body.extend_from_slice(b"--fixture-boundary\r\nContent-Disposition: form-data; name=\"unknown\"\r\n\r\ninvalid\r\n--fixture-boundary--\r\n");
    let result = call(
        &app,
        "POST",
        "/api/live2d-import",
        body,
        "multipart/form-data; boundary=fixture-boundary",
    )
    .await;
    assert_eq!(result.status(), StatusCode::BAD_REQUEST);
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while fs::read_dir(&service.local).unwrap().count() != 1 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        fs::read(retained.join("keep.txt")).unwrap(),
        b"existing fixture"
    );
}
