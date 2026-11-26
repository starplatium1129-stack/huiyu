use super::{
    Error, Result, SamplingOptions,
    persona::{self, length, string, trimmed_string},
};
use serde_json::Value;

fn bounded_float(value: &Value, min: f64, max: f64, label: &str) -> Result<Option<f64>> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(num) = value.as_f64() else {
        return Err(Error::invalid(format!("{label} 必须是数字")));
    };
    if !num.is_finite() || num < min || num > max {
        return Err(Error::invalid(format!("{label} 超出允许范围（{min} ~ {max}）")));
    }
    Ok(Some(num))
}

pub(super) fn parse_context_budget(body: &Value) -> Result<(usize, usize)> {
    let Some(budget) = body.get("contextBudget").filter(|v| !v.is_null()) else {
        return Ok((persona::HISTORY_LIMIT, persona::TEXT_LIMIT));
    };
    if !budget.is_object() {
        return Err(Error::invalid("上下文预算格式错误"));
    }
    let max_messages = match budget.get("maxMessages").filter(|v| !v.is_null()) {
        None => persona::HISTORY_LIMIT,
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| Error::invalid("最大消息条数必须是整数"))?;
            if !(8..=persona::MAX_HISTORY_LIMIT as u64).contains(&n) {
                return Err(Error::invalid("最大消息条数必须在 8 到 120 之间"));
            }
            n as usize
        }
    };
    let max_chars = match budget.get("maxChars").filter(|v| !v.is_null()) {
        None => persona::TEXT_LIMIT,
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| Error::invalid("上下文字符预算必须是整数"))?;
            if !(4000..=persona::MAX_TEXT_LIMIT as u64).contains(&n) {
                return Err(Error::invalid("上下文字符预算必须在 4000 到 120000 之间"));
            }
            n as usize
        }
    };
    Ok((max_messages, max_chars))
}

pub(super) fn parse_sampling(body: &Value) -> Result<SamplingOptions> {
    let Some(sampling) = body.get("sampling").filter(|v| !v.is_null()) else {
        return Ok(SamplingOptions::default());
    };
    if !sampling.is_object() {
        return Err(Error::invalid("采样参数格式错误"));
    }
    let max_tokens = match sampling.get("maxTokens").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| Error::invalid("最大输出长度必须是整数"))?;
            if !(64..=16384).contains(&n) {
                return Err(Error::invalid("最大输出长度必须在 64 到 16384 之间"));
            }
            Some(n as u32)
        }
    };
    Ok(SamplingOptions {
        temperature: bounded_float(&sampling["temperature"], 0.0, 2.0, "Temperature")?,
        top_p: bounded_float(&sampling["topP"], 0.0, 1.0, "Top P")?,
        max_tokens,
        frequency_penalty: bounded_float(&sampling["frequencyPenalty"], -2.0, 2.0, "Frequency Penalty")?,
        presence_penalty: bounded_float(&sampling["presencePenalty"], -2.0, 2.0, "Presence Penalty")?,
    })
}

pub(super) fn parse_rp_options(body: &Value, history_limit: usize) -> Result<persona::RpOptions> {
    let mut rp = persona::RpOptions::default();
    if let Some(preset) = body.get("rpPreset").filter(|v| !v.is_null()) {
        if !preset.is_object() {
            return Err(Error::invalid("RP 预设格式错误"));
        }
        let prefix = string(&preset["systemPrefix"]);
        let post = string(&preset["postHistory"]);
        if length(&prefix) > 4000 || length(&post) > 4000 {
            return Err(Error::invalid("RP 预设提示词不能超过 4000 字"));
        }
        rp.system_prefix = prefix;
        rp.post_history = post;
        rp.disable_bubble_split = preset["disableBubbleSplit"] == true;
        rp.status_bar_enabled = preset["statusBarEnabled"] == true;
    }
    if let Some(note) = body.get("authorNote").filter(|v| !v.is_null()) {
        if !note.is_object() {
            return Err(Error::invalid("作者注释格式错误"));
        }
        let text = string(&note["text"]);
        if length(&text) > 2000 {
            return Err(Error::invalid("作者注释不能超过 2000 字"));
        }
        let depth = match note.get("depth").filter(|v| !v.is_null()) {
            None => 2usize,
            Some(v) => v
                .as_u64()
                .filter(|&d| d <= 24)
                .ok_or_else(|| Error::invalid("作者注释深度必须在 0 到 24 之间"))?
                as usize,
        };
        if !text.trim().is_empty() {
            rp.author_note = Some((depth.min(history_limit), text));
        }
    }
    if let Some(aff) = body.get("affection").filter(|v| !v.is_null()) {
        if !aff.is_object() {
            return Err(Error::invalid("好感度参数格式错误"));
        }
        let score = aff["score"]
            .as_u64()
            .filter(|&s| s <= 100)
            .ok_or_else(|| Error::invalid("好感度分值必须在 0 到 100 之间"))? as u8;
        let level = aff["level"]
            .as_u64()
            .filter(|&l| (1..=5).contains(&l))
            .ok_or_else(|| Error::invalid("好感度等级必须在 1 到 5 之间"))? as u8;
        let title = trimmed_string(&aff["title"]);
        let description = trimmed_string(&aff["description"]);
        if title.is_empty() || length(&title) > 32 || length(&description) > 160 {
            return Err(Error::invalid("好感度等级说明格式错误或过长"));
        }
        rp.affection = Some(persona::AffectionContext {
            score,
            level,
            title,
            description,
        });
    }
    if let Some(scene) = body.get("sceneState").filter(|v| !v.is_null()) {
        if !scene.is_object() {
            return Err(Error::invalid("现场状态参数格式错误"));
        }
        let location = trimmed_string(&scene["location"]);
        let outfit = trimmed_string(&scene["outfit"]);
        let mood = trimmed_string(&scene["mood"]);
        if length(&location) > 80 || length(&outfit) > 160 || length(&mood) > 40 {
            return Err(Error::invalid("现场状态字段过长"));
        }
        if !location.is_empty() || !outfit.is_empty() || !mood.is_empty() {
            rp.scene_state = Some(persona::SceneStateContext {
                location,
                outfit,
                mood,
            });
        }
    }
    if let Some(summary) = body.get("storySummary").filter(|v| !v.is_null()) {
        let summary = trimmed_string(summary);
        if length(&summary) > 3000 {
            return Err(Error::invalid("前情提要摘要不能超过 3000 字"));
        }
        rp.story_summary = summary;
    }
    if let Some(raw_lore) = body.get("lorebooks").filter(|v| !v.is_null()) {
        if !raw_lore.is_object() {
            return Err(Error::invalid("世界书参数格式错误"));
        }
        let book: persona::ExternalLorebook = serde_json::from_value(raw_lore.clone())
            .map_err(|_| Error::invalid("世界书条目格式错误"))?;
        if book.entries.len() > 200 {
            return Err(Error::invalid("世界书条目最多 200 条"));
        }
        if book.entries.iter().any(|entry| length(&entry.content) > 4000) {
            return Err(Error::invalid("单条世界书内容不能超过 4000 字"));
        }
        rp.external_lore = Some(book);
    }
    Ok(rp)
}
