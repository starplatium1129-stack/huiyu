use super::*;
use huiyu_runtime::{generation, images, upstream::LocalUpstream, video};

#[tokio::test]
async fn upload_fields_keep_json_rejections_and_image_video_validation() {
    let (_directory, mut state, _) = fixture().await;
    let config = generation::Config {
        sd_host: state.config.sd_host.clone(),
        sd_auth: None,
        comfy_host: state.config.comfy_host.clone(),
        ai_workspace_root: state.config.ai_workspace_root.clone(),
        runtime_root: state.config.runtime_root.clone(),
    };
    let images = Arc::new(
        images::Service::new(config.clone(), LocalUpstream::new(), state.shutdown.clone()).unwrap(),
    );
    let video = Arc::new(
        video::Service::new(config, LocalUpstream::new(), state.shutdown.clone()).unwrap(),
    );
    state.images = Some(images.clone());
    state.video = Some(video.clone());
    let app = huiyu_runtime::router(state.clone());
    for (route, key, missing_code, prefix) in [
        (
            "/api/anima/images",
            "image",
            "INVALID_BODY",
            "aics_anima_input_",
        ),
        (
            "/api/video/images",
            "data",
            "INVALID_IMAGE",
            "aics_video_ref_",
        ),
    ] {
        for body in [json!({}), Value::Null, json!({key:123})] {
            let response = request(&app, "POST", route, body.to_string(), &[]).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(json_body(response).await["code"], missing_code);
        }
        assert_eq!(
            request(&app, "POST", route, "{".into(), &[]).await.status(),
            StatusCode::BAD_REQUEST
        );
        let empty = request(&app, "POST", route, json!({key:""}).to_string(), &[]).await;
        assert_eq!(empty.status(), StatusCode::BAD_REQUEST);
        assert_eq!(json_body(empty).await["code"], "INVALID_IMAGE");
        let image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let response = request(
            &app,
            "POST",
            route,
            json!({key:image,"kind":"reference"}).to_string(),
            &[],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(
            json_body(response).await["name"]
                .as_str()
                .unwrap()
                .starts_with(prefix)
        );
    }
    images.close().await;
    video.close().await;
    state.host.storage().unwrap().close().await.unwrap();
}
