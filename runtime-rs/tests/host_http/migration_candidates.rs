use super::*;

#[tokio::test]
async fn new_candidate_preserves_old_data_and_resume_requires_saved_identity() {
    let (directory, mut state, _) = fixture().await;
    state.host.storage().unwrap().close().await.unwrap();
    let root = directory.path().join("desktop");
    Arc::make_mut(&mut state.config).config_root = Some(root.clone());
    state.host = Arc::new(HostAuthority::new(None, None, None));
    let app = huiyu_runtime::router(state.clone());
    let a = json_body(
        signed_with(
            &app,
            "prepare-candidate",
            "atelier",
            json!({"candidate":{"mode":"new"}}),
        )
        .await,
    )
    .await;
    let id_a = a["workspace"]["workspaceId"].as_str().unwrap();
    let token_a = a["workspace"]["token"].as_str().unwrap();
    let mut envelope = json!({"format":"huiyu-migration","version":1,"migrationId":"original",
        "target":{"workspaceId":id_a},"source":{"sourceProfileId":"host-test","origin":ORIGIN,"windowIds":["atelier"]},
        "createdAt":1,"records":[],"media":[],"blockers":[],"credentials":{"references":[],"verified":true}});
    envelope["fingerprint"] = json!(huiyu_runtime::storage::fingerprint(&envelope));
    assert_eq!(request(&app,"POST","/api/workspace/migrations",json!({"operationId":"begin-a","workspaceId":id_a,"protocolVersion":1,"envelope":envelope}).to_string(), &[("origin",ORIGIN),("x-aics-workspace-session",token_a)]).await.status(),StatusCode::OK);
    let b = json_body(
        signed_with(
            &app,
            "prepare-candidate",
            "atelier",
            json!({"candidate":{"mode":"new"}}),
        )
        .await,
    )
    .await;
    let id_b = b["workspace"]["workspaceId"].as_str().unwrap();
    let token_b = b["workspace"]["token"].as_str().unwrap();
    assert_ne!(
        id_b, id_a,
        "Explicit new migration must not reuse a nonempty candidate"
    );
    let path_a = root.join("workspaces").join(id_a);
    let path_b = root.join("workspaces").join(id_b);
    assert!(path_a.join("huiyu.sqlite3").is_file());
    assert!(!path_a.join(".workspace-owner.json").exists());
    assert_eq!(
        request(
            &app,
            "GET",
            "/api/workspace/status",
            String::new(),
            &[("origin", ORIGIN), ("x-aics-workspace-session", token_a)]
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let headers_b = [("origin", ORIGIN), ("x-aics-workspace-session", token_b)];
    assert_eq!(request(&app,"POST","/api/workspace/migrations",json!({"operationId":"wrong-target","workspaceId":id_b,"protocolVersion":1,"envelope":envelope}).to_string(), &headers_b).await.status(),StatusCode::CONFLICT);
    let mut legacy = envelope.clone();
    legacy.as_object_mut().unwrap().remove("fingerprint");
    legacy.as_object_mut().unwrap().remove("target");
    legacy["migrationId"] = json!("changed-source");
    legacy["createdAt"] = json!(2);
    legacy["fingerprint"] = json!(huiyu_runtime::storage::fingerprint(&legacy));
    assert_eq!(request(&app,"POST","/api/workspace/migrations",json!({"operationId":"begin-b","workspaceId":id_b,"protocolVersion":1,"envelope":legacy}).to_string(), &headers_b).await.status(),StatusCode::OK);
    // Legacy backups may use only their original currently selected candidate.
    assert_eq!(signed_with(&app,"prepare-candidate","atelier",json!({"candidate":{"mode":"resume","migrationId":"original","expectedFingerprint":envelope["fingerprint"]}})).await.status(),StatusCode::CONFLICT);
    assert_eq!(signed_with(&app,"prepare-candidate","atelier",json!({"candidate":{"mode":"resume","migrationId":"changed-source","expectedFingerprint":legacy["fingerprint"]}})).await.status(),StatusCode::OK);
    assert_eq!(signed_with(&app,"prepare-candidate","atelier",json!({"candidate":{"mode":"resume","workspaceId":id_a,"migrationId":"original","expectedFingerprint":"f".repeat(64)}})).await.status(),StatusCode::CONFLICT);
    assert_eq!(state.host.storage().unwrap().workspace_id(), id_b);
    let resumed = signed_with(&app,"prepare-candidate","atelier",json!({"candidate":{"mode":"resume","workspaceId":id_a,"migrationId":"original","expectedFingerprint":envelope["fingerprint"]}})).await;
    assert_eq!(resumed.status(), StatusCode::OK);
    let resumed = json_body(resumed).await;
    assert_eq!(resumed["workspace"]["workspaceId"], id_a);
    assert_ne!(
        resumed["workspace"]["runtimeEpoch"],
        a["workspace"]["runtimeEpoch"]
    );
    assert!(path_b.join("huiyu.sqlite3").is_file());
    assert!(!path_b.join(".workspace-owner.json").exists());
    state.host.storage().unwrap().close().await.unwrap();
}
