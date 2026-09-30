use super::*;

#[test]
fn terminal_events_are_only_hints_for_watched_prompts() {
    let active = HashSet::from(["owned".into()]);
    let mut states = HashMap::new();
    for event in [
        "execution_success",
        "execution_error",
        "execution_interrupted",
    ] {
        let update = apply(
            &format!(r#"{{"type":"{event}","data":{{"prompt_id":"owned"}}}}"#),
            &active,
            &mut states,
        )
        .unwrap();
        assert!(update.terminal_hint());
        assert_eq!(update.prompt_id, "owned");
        assert!(
            apply(
                &format!(r#"{{"type":"{event}","data":{{"prompt_id":"foreign"}}}}"#),
                &active,
                &mut states,
            )
            .is_none()
        );
    }
    let running = apply(
        r#"{"type":"executing","data":{"prompt_id":"owned","node":"7"}}"#,
        &active,
        &mut states,
    )
    .unwrap();
    assert!(!running.terminal_hint());
    let finishing = apply(
        r#"{"type":"executing","data":{"prompt_id":"owned","node":null}}"#,
        &active,
        &mut states,
    )
    .unwrap();
    assert!(finishing.terminal_hint());
}
