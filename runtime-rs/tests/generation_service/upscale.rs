use super::*;

#[tokio::test]
async fn comfy_upscalers_resolve_exact_models_and_record_auto_separately() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("ai/ComfyUI/models");
    tokio::fs::create_dir_all(root.join("checkpoints"))
        .await
        .unwrap();
    tokio::fs::write(
        root.join("checkpoints/waiIllustriousSDXL_v170.safetensors"),
        b"fixture",
    )
    .await
    .unwrap();
    let models = root.join("upscale_models");
    tokio::fs::create_dir_all(&models).await.unwrap();
    let official = "RealESRGAN_x4plus_anime_6B.pth";
    let alias = "R-ESRGAN 4x+ Anime6B.pth";
    tokio::fs::write(models.join(official), b"isolated fixture")
        .await
        .unwrap();
    let (state, _) = mock(false, true);
    let server = server(state.clone()).await;
    let service = service(&server, &temp);
    let status = service.get_status().await.unwrap();
    let available = status["capabilities"]["hiresUpscalers"].as_array().unwrap();
    assert!(available.contains(&json!("R-ESRGAN 4x+ Anime6B")));
    assert!(!available.contains(&json!("Remacri")));
    assert_eq!(status["capabilities"]["superResModel"], official);
    let mut body = input(42);
    body["hiresFix"] = json!(true);
    body["hiresUpscaler"] = json!("Auto");
    let prepared = service
        .prepare(body.clone(), true, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(prepared.input["hiresUpscaler"], "R-ESRGAN 4x+ Anime6B");
    let job = service
        .clone()
        .submit(prepared, "owner".into(), None)
        .await
        .unwrap();
    let id = job["id"].as_str().unwrap();
    settled(&service, id, "succeeded").await;
    let job = service.get_job(id, "owner").await.unwrap();
    assert_eq!(job["metadata"]["requestedHiresUpscaler"], "Auto");
    assert_eq!(job["metadata"]["hiresUpscaler"], "R-ESRGAN 4x+ Anime6B");
    assert_eq!(job["metadata"]["superResModel"], official);
    assert_eq!(
        state.payloads.lock().unwrap()[0]["prompt"]["11"]["inputs"]["model_name"],
        official
    );
    body["hiresUpscaler"] = json!("Remacri");
    let missing = service
        .prepare(body.clone(), true, CancellationToken::new())
        .await;
    assert!(matches!(missing, Err(error) if error.code == "SUPER_RES_MODEL_UNAVAILABLE"));
    tokio::fs::write(models.join(alias), b"legacy fixture")
        .await
        .unwrap();
    tokio::fs::write(models.join("4x_foolhardy_Remacri.safetensors"), b"fixture")
        .await
        .unwrap();
    tokio::fs::write(models.join("RealESRGAN_x4plus.pth"), b"fixture")
        .await
        .unwrap();
    body["hiresUpscaler"] = json!("R-ESRGAN 4x+ Anime6B");
    let prepared = service
        .prepare(body.clone(), true, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(prepared.input["superResModel"], official);
    drop(prepared);
    tokio::fs::remove_file(models.join(official)).await.unwrap();
    for (requested, file) in [
        ("R-ESRGAN 4x+ Anime6B", alias),
        ("Remacri", "4x_foolhardy_Remacri.safetensors"),
        ("R-ESRGAN 4x+", "RealESRGAN_x4plus.pth"),
    ] {
        body["hiresUpscaler"] = json!(requested);
        let prepared = service
            .prepare(body.clone(), true, CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(prepared.input["superResModel"], file);
        assert_eq!(prepared.input["hiresUpscaler"], requested);
        assert_eq!(prepared.input["requestedHiresUpscaler"], requested);
    }
    service.close().await;
}
