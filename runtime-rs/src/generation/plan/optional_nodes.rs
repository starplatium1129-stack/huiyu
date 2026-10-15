use super::*;

const AUTOMATIC_MASK: &[&str] = &["AP_CLIPSeg_TextMask"];
const KREA: &[&str] = &["ConditioningKrea2Rebalance", "ComfyUI-Krea2T-Enhancer"];

async fn available(inner: &Inner, name: &str, cancel: &CancellationToken) -> Option<bool> {
    let info = inner
        .json(
            "comfy",
            reqwest::Method::GET,
            &format!("/object_info/{name}"),
            None,
            Duration::from_secs(5),
            cancel,
        )
        .await
        .ok()?;
    let nodes = info.as_object()?;
    // Comfy returns {} for an absent class; HTTP/shape failures stay unknown.
    if nodes.is_empty() {
        Some(false)
    } else if nodes.len() == 1 && nodes.get(name)?["input"].is_object() {
        Some(true)
    } else {
        None
    }
}

fn readiness(required: &[&str], states: &[Option<bool>]) -> Value {
    let known = states.iter().all(Option::is_some);
    let missing: Vec<_> = required
        .iter()
        .zip(states)
        .filter_map(|(name, state)| (known && *state == Some(false)).then_some(*name))
        .collect();
    json!({"state":if !known{"unknown"}else if missing.is_empty(){"ready"}else{"missing"},"required":required,"missing":missing})
}

pub(super) async fn status(
    inner: &Inner,
    cancel: &CancellationToken,
    workflow: Option<&Value>,
) -> Value {
    // Admission queries only the selected groups; the control panel queries all.
    // Required classes stay fresh without enumerating all installed nodes.
    let mask_selected = workflow.is_none_or(|workflow| selected(workflow, AUTOMATIC_MASK));
    let krea_selected = workflow.is_none_or(|workflow| selected(workflow, KREA));
    let (mask, rebalance, enhancer) = tokio::join!(
        async {
            if mask_selected {
                available(inner, AUTOMATIC_MASK[0], cancel).await
            } else {
                None
            }
        },
        async {
            if krea_selected {
                available(inner, KREA[0], cancel).await
            } else {
                None
            }
        },
        async {
            if krea_selected {
                available(inner, KREA[1], cancel).await
            } else {
                None
            }
        },
    );
    json!({"automaticMask":readiness(AUTOMATIC_MASK,&[mask]),"krea2":readiness(KREA,&[rebalance,enhancer])})
}

pub(super) fn requested(workflow: &Value) -> bool {
    selected(workflow, AUTOMATIC_MASK) || selected(workflow, KREA)
}

fn selected(workflow: &Value, names: &[&str]) -> bool {
    workflow
        .as_object()
        .into_iter()
        .flat_map(|graph| graph.values())
        .any(|node| {
            node["class_type"]
                .as_str()
                .is_some_and(|name| names.contains(&name))
        })
}

pub(super) fn validate(workflow: &Value, status: &Value) -> Result<()> {
    for (key, names, label) in [
        ("automaticMask", AUTOMATIC_MASK, "文字自动蒙版"),
        ("krea2", KREA, "Krea 2"),
    ] {
        if !selected(workflow, names) || status[key]["state"] == "ready" {
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
