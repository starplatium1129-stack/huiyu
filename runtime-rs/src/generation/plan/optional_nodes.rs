use super::*;

const AUTOMATIC_MASK: &[&str] = &["AP_CLIPSeg_TextMask"];
const KREA: &[&str] = &["ConditioningKrea2Rebalance", "ComfyUI-Krea2T-Enhancer"];

fn readiness(info: Option<&serde_json::Map<String, Value>>, required: &[&str]) -> Value {
    let missing: Vec<_> = info
        .map(|info| {
            required
                .iter()
                .filter(|name| !info.contains_key(**name))
                .copied()
                .collect()
        })
        .unwrap_or_default();
    json!({"state":if info.is_none(){"unknown"}else if missing.is_empty(){"ready"}else{"missing"},"required":required,"missing":missing})
}

pub(super) fn status(info: Option<&Value>) -> Value {
    let info = info
        .and_then(Value::as_object)
        .filter(|info| !info.is_empty() && info.values().all(|node| node["input"].is_object()));
    json!({"automaticMask":readiness(info,AUTOMATIC_MASK),"krea2":readiness(info,KREA)})
}

pub(super) fn requested(workflow: &Value) -> bool {
    workflow
        .as_object()
        .into_iter()
        .flat_map(|graph| graph.values())
        .any(|node| {
            node["class_type"]
                .as_str()
                .is_some_and(|name| AUTOMATIC_MASK.contains(&name) || KREA.contains(&name))
        })
}

pub(super) fn validate(workflow: &Value, status: &Value) -> Result<()> {
    for (key, names, label) in [
        ("automaticMask", AUTOMATIC_MASK, "文字自动蒙版"),
        ("krea2", KREA, "Krea 2"),
    ] {
        let selected = workflow
            .as_object()
            .into_iter()
            .flat_map(|graph| graph.values())
            .any(|node| {
                node["class_type"]
                    .as_str()
                    .is_some_and(|name| names.contains(&name))
            });
        if !selected || status[key]["state"] == "ready" {
            continue;
        }
        let message = if status[key]["state"] == "missing" {
            let missing = status[key]["missing"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("、");
            format!(
                "{label}缺少 ComfyUI 节点：{missing}。当前一键准备包不包含这些扩展，也没有已登记的固定安装来源；请在控制面板核对所用环境。文字蒙版可改用手绘遮罩。"
            )
        } else {
            format!(
                "{label}的 ComfyUI 节点尚未确认，未提交生成。请到控制面板确认服务已启动后重新检查；文字蒙版可改用手绘遮罩。"
            )
        };
        return Err(ApiError::new(
            409,
            "COMFY_OPTIONAL_NODES_UNAVAILABLE",
            message,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_nodes_are_checked_per_requested_capability_and_fail_closed() {
        let basic = json!({"1":{"class_type":"UNETLoader"}});
        let mask = json!({"1":{"class_type":"AP_CLIPSeg_TextMask"}});
        let krea = json!({"1":{"class_type":"ConditioningKrea2Rebalance"},"2":{"class_type":"ComfyUI-Krea2T-Enhancer"}});
        let baseline = status(Some(&json!({"UNETLoader":{"input":{}}})));
        assert!(!requested(&basic));
        assert!(requested(&mask));
        assert!(validate(&basic, &baseline).is_ok());
        assert_eq!(baseline["automaticMask"]["missing"], json!(AUTOMATIC_MASK));
        assert_eq!(baseline["krea2"]["missing"], json!(KREA));
        for graph in [&mask, &krea] {
            let error = validate(graph, &baseline).unwrap_err();
            assert_eq!(error.code, "COMFY_OPTIONAL_NODES_UNAVAILABLE");
            assert!(error.message.contains("当前一键准备包不包含"));
            assert!(
                validate(graph, &status(None))
                    .unwrap_err()
                    .message
                    .contains("尚未确认")
            );
        }
        for invalid in [json!({}), json!({"AP_CLIPSeg_TextMask":{}})] {
            assert_eq!(status(Some(&invalid))["automaticMask"]["state"], "unknown");
        }
        let mask_only = status(Some(&json!({"AP_CLIPSeg_TextMask":{"input":{}}})));
        assert!(validate(&mask, &mask_only).is_ok());
        assert!(validate(&krea, &mask_only).is_err());
        let complete = status(Some(
            &json!({"AP_CLIPSeg_TextMask":{"input":{}},"ConditioningKrea2Rebalance":{"input":{}},"ComfyUI-Krea2T-Enhancer":{"input":{}}}),
        ));
        assert!(validate(&mask, &complete).is_ok());
        assert!(validate(&krea, &complete).is_ok());
    }
}
