use super::*;
pub(super) fn messages(action: &str, input: &Value) -> Vec<Value> {
    let identity = string(&input["identity"], "(none)");
    let user = match action {
        "rewrite" => format!(
            "Identity anchor (for reference only, do not restate it in the shot description): {identity}\n\nStill-image prompt (what generated the first frame):\n{}\n\nCurrent shot parameters: shotSize={}, camera={}, motion={}{}\n\nRewrite this shot for video:",
            text(&input["prompt"]),
            string(&input["shotSize"], "default"),
            text(&input["camera"]),
            text(&input["motion"]),
            if truthy(&input["dialogue"]) {
                format!(", dialogue={}", text(&input["dialogue"]))
            } else {
                String::new()
            }
        ),
        "polish" | "review" => {
            let mut lines = if action == "polish" {
                vec![
                    format!("Identity anchor (for reference only): {identity}"),
                    String::new(),
                ]
            } else {
                vec![]
            };
            lines.push(
                "Shot list (index | shotSize | camera | motion | dialogue | description):".into(),
            );
            for (index, shot) in list(&input["shots"]).iter().enumerate() {
                lines.push(format!(
                    "{}. {} | {} | {} | {} | {}",
                    index + 1,
                    string(&shot["shotSize"], "default"),
                    text(&shot["camera"]),
                    text(&shot["motion"]),
                    crate::storage::stringify(&shot["dialogue"]),
                    limited(
                        &text(&shot["prompt"]),
                        if action == "polish" { 160 } else { 200 }
                    )
                ));
            }
            lines.push(String::new());
            lines.push(
                if action == "polish" {
                    "Adjust the rhythm of this shot list:"
                } else {
                    "Inspect this shot list:"
                }
                .into(),
            );
            lines.join("\n")
        }
        "dialogue" => {
            let mut lines = vec![
                format!("Identity anchor (for reference only): {identity}"),
                format!("Shot description: {}", text(&input["prompt"])),
            ];
            if truthy(&input["currentDialogue"]) {
                lines.push(format!(
                    "Current dialogue: {}",
                    text(&input["currentDialogue"])
                ));
            }
            if truthy(&input["mood"]) {
                lines.push(format!("Requested mood: {}", text(&input["mood"])));
            }
            lines.push(
                if truthy(&input["currentDialogue"]) {
                    "Polish the current dialogue and give two alternatives:"
                } else {
                    "Write three dialogue options for this shot:"
                }
                .into(),
            );
            lines.join("\n")
        }
        "script" => {
            let mut lines = vec![format!("Identity anchor (for reference only): {identity}")];
            if !list(&input["characterLabels"]).is_empty() {
                lines.push(format!(
                    "Characters: {}",
                    list(&input["characterLabels"])
                        .iter()
                        .enumerate()
                        .map(|(i, label)| format!("<Picture {}> = {}", i + 1, text(label)))
                        .collect::<Vec<_>>()
                        .join("; ")
                ));
            }
            lines.push(format!("Story synopsis: {}", text(&input["story"])));
            if truthy(&input["shotCount"]) {
                lines.push(format!("Target shot count: {}", text(&input["shotCount"])));
            }
            if truthy(&input["totalSeconds"]) {
                lines.push(format!(
                    "Target total duration: {} seconds",
                    text(&input["totalSeconds"])
                ));
            }
            lines.push(String::new());
            lines.push("Create the shot list:".into());
            lines.join("\n")
        }
        _ => unreachable!(),
    };
    vec![
        json!({"role":"system","content":CONSTANTS[format!("{}_SYSTEM_PROMPT",action.to_uppercase())]}),
        json!({"role":"user","content":user}),
    ]
}
