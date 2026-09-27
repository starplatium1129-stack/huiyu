use super::*;
use std::collections::HashSet;
pub(in crate::maintenance) struct Prepared {
    pub state: state::State,
    pub version: u64,
    pub scenes: Vec<Value>,
    pub tags: Option<Value>,
    pub curation: Option<Value>,
    pub blueprints: Option<blueprints::Prepared>,
    pub next_blueprints: Option<Vec<Value>>,
}
pub(in crate::maintenance) fn prepare(
    options: &Options,
    body: &Value,
    import: bool,
) -> Result<Prepared> {
    let token = journal::read_token(options)?;
    let base = body["baseVersion"]
        .as_f64()
        .filter(|number| {
            number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991_f64
        })
        .map(|number| number as i64)
        .ok_or_else(|| {
            let mut error = Error::new(
                409,
                "SCENE_BASE_VERSION_REQUIRED",
                "保存缺少读取基线版本（baseVersion）。请先重新加载场景库再保存。",
            );
            if let Ok(version) = state::version(&options.root) {
                error.extra = json!({"conflict":{"currentVersion":version}}).into();
            }
            error
        })?;
    let state = state::read(options)?;
    let version = state.value["version"].as_u64().unwrap();
    let current = &state.value["snapshot"];
    let previous = current["scenes"].as_array().unwrap();
    if base != version as i64 {
        let empty = Vec::new();
        let incoming = if import {
            &body["scenes"]
        } else {
            &body["changeSet"]["scenes"]["upsert"]
        }
        .as_array()
        .unwrap_or(&empty);
        let mut error = Error::new(
            409,
            "SCENE_CONFLICT",
            "场景库在编辑期间已被更新，请先导出草稿，再重新读取并合并改动。",
        );
        error.extra = json!({"conflict":{"baseVersion":base,"currentVersion":version,"serverOnlyIds":if import{previous.iter().filter(|scene|!incoming.iter().any(|next|next["id"]==scene["id"])).map(|scene|scene["id"].clone()).collect::<Vec<_>>()}else{Vec::new()},"clientNewIds":incoming.iter().filter(|scene|!previous.iter().any(|before|before["id"]==scene["id"])).map(|scene|scene["id"].clone()).collect::<Vec<_>>(),"changedIds":incoming.iter().filter(|scene|previous.iter().any(|before|before["id"]==scene["id"]&&crate::storage::stringify(before)!=crate::storage::stringify(scene))).map(|scene|scene["id"].clone()).collect::<Vec<_>>()}}).into();
        return Err(error);
    }
    let source = if import {
        body
    } else {
        if ["scenes", "blueprints", "tags", "curation"]
            .iter()
            .any(|key| body.get(key).is_some())
        {
            return Err(Error::invalid("变更集请求不得混入全量快照"));
        }
        let change = &body["changeSet"];
        if change["version"] != 1
            || change.as_object().is_none_or(|fields| {
                fields.keys().any(|key| {
                    !["version", "scenes", "blueprints", "tags", "curation"].contains(&key.as_str())
                })
            })
        {
            return Err(Error::invalid("不支持的场景变更集；需要 version: 1"));
        }
        change
    };
    let scenes = if import {
        validation::collection(&source["scenes"])?.clone()
    } else {
        validation::changed(previous, &source["scenes"])?
    };
    if scenes.is_empty() {
        return Err(Error::invalid("场景库不能为空"));
    }
    for scene in &scenes {
        if state.retired.contains(scene["id"].as_str().unwrap()) {
            return Err(Error::invalid(format!(
                "{} 已退役，不能复用已退役身份",
                scene["id"]
            )));
        }
    }
    validation::protect_pins(&options.root, previous, &scenes)?;
    let tags = source.get("tags").cloned();
    if let Some(tags) = &tags {
        validation::tags(tags)?;
    }
    let active = scenes
        .iter()
        .filter_map(|scene| scene["id"].as_str())
        .collect::<HashSet<_>>();
    let curation = source
        .get("curation")
        .map(|value| validation::curation(value, &active, &current["curation"]))
        .transpose()?;
    let next_blueprints = source
        .get("blueprints")
        .map(|value| {
            if import {
                blueprints::collection(value).cloned()
            } else {
                blueprints::changed(current["blueprints"].as_array().unwrap(), value)
            }
        })
        .transpose()?;
    let blueprints = next_blueprints
        .as_ref()
        .map(|value| blueprints::prepare(options, value, current["blueprints"].as_array().unwrap()))
        .transpose()?;
    state::scene_plan(&state, &scenes)?;
    journal::assert_token(options, &token)?;
    Ok(Prepared {
        state,
        version,
        scenes,
        tags,
        curation,
        blueprints,
        next_blueprints,
    })
}
