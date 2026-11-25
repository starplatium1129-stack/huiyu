use super::clean::{CastFormation, clean_cast_prose, clean_moss_reference_prose, ensure_sentence};
use super::ref_layout::{NormalizedRefItem, ParsedReferenceLayout};
use super::super::*;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

const MAX_LAYOUT_ITEMS: usize = 16;
const MAX_PROMPT_UTF16: usize = 12_000;

static RE_LEAD_WRAP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:the |a |an )?(?:(?:foreground|background|left|right|central|center|front|rear|far|near) )*([a-z]+)-(wrapped|clad)\s+(?:character|subject|person|figure|woman|man|girl|boy)\b[,]?\s*")
        .unwrap()
});
static RE_LEAD_SUBJ: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:the |a |an )?(?:(?:foreground|background|left|right|central|center|front|rear|far|near|seated|standing|leaning|smiling|grinning|laughing) )*(?:character|subject|person|figure|woman|man|girl|boy)\b(?:(?:\s*,\s*)|\s+(?:is|are)\s+|\s+)?")
        .unwrap()
});
static RE_MID_SUBJ: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([.!?]\s+)(?:the |a |an )?(?:(?:left|right|central|center|foreground|background) )?(?:character|subject|person|figure)\s+")
        .unwrap()
});
static RE_REF_VERB_OUTFIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[,;.]\s*|\s+)(?:(?:is|are)\s+)?((?:wears?|wearing|dressed in|clad in|outfitted in|wrapped in|draped in)\s+[^.!?;]+)")
        .unwrap()
});
static RE_REF_AFTER_CLOTHES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)(?:\s+(?:while|beside|near|next to|in front of|at (?:a|an|the))\s+|",
        r"\s*,\s*(?:holding|standing|sitting|seated|leaning|walking|looking|smiling|laughing|glancing|resting|bracing|raising|reaching|kneeling|lying|turning|turned|wading)\b)",
    ))
    .unwrap()
});
static RE_REF_IN_OUTFIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^in\s+((?:a|an|the)\s+[^,.;!?]+?)(?:\s*,\s*|\s+(?:standing|stands?|sitting|sits?|seated|leaning|leans?|lying|lies|kneeling|holding|smiling|laughing|looking|glancing|turning|turned|walking|running|wading|facing|posing|tilting|tilts?)\b|[.!?;]|$)")
        .unwrap()
});
static RE_REF_STATE_OUTFIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b((?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked|unclothed|topless|bottomless|shirtless)|without (?:any )?clothes)\b")
        .unwrap()
});
static RE_OUTFIT_VERB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:wears?|wearing|dressed|clad|wrapped|draped|in\s+(?:a|an|the)\b|nude|naked|topless|bottomless|unclothed)\b")
        .unwrap()
});
static RE_TRAITS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bwith\s+([^.;]+)").unwrap());

pub(super) struct MossCastSubject {
    pub(super) name: String,
    pub(super) caption: String,
    pub(super) identity_caption: String,
    pub(super) outfit_caption: String,
    pub(super) outfit_explicit: bool,
    pub(super) action: String,
    pub(super) custom_bbox: Option<[f64; 4]>,
}

pub(super) fn moss_normalized_box(width: u64, height: u64, [y1, x1, y2, x2]: [f64; 4]) -> [i64; 4] {
    let (w, h) = (width as f64, height as f64);
    let (half_w, half_h) = (w / 2.0, h / 2.0);
    let (min_y, max_y) = ((-half_h).ceil() as i64, half_h.floor() as i64);
    let (min_x, max_x) = ((-half_w).ceil() as i64, half_w.floor() as i64);
    let clamp01 = |n: f64| if n.is_finite() { n.clamp(0.0, 1.0) } else { 0.0 };
    let clamp_int = |v: f64, lo: i64, hi: i64| (v.round() as i64).clamp(lo, hi);

    let [ny1, nx1, ny2, nx2] = [y1, x1, y2, x2].map(clamp01);
    let mut top = clamp_int(ny1 * h - half_h, min_y, max_y - 1);
    let mut bottom = clamp_int(ny2 * h - half_h, min_y + 1, max_y);
    if bottom <= top {
        if top < max_y { bottom = top + 1; } else { top = bottom - 1; }
    }
    let mut left = clamp_int(nx1 * w - half_w, min_x, max_x - 1);
    let mut right = clamp_int(nx2 * w - half_w, min_x + 1, max_x);
    if right <= left {
        if left < max_x { right = left + 1; } else { left = right - 1; }
    }
    [top, left, bottom, right]
}

fn row_unit_boxes(length: usize, top: f64, left: f64, bottom: f64, right: f64, overlap: f64) -> Vec<[f64; 4]> {
    let n = length as f64;
    let span = (right - left) / (n - overlap * (n - 1.0));
    (0..length)
        .map(|index| {
            let start = left + (index as f64) * span * (1.0 - overlap);
            [top, start, bottom, start + span]
        })
        .collect()
}

fn moss_cast_unit_boxes(count: usize, formation: CastFormation) -> Vec<[f64; 4]> {
    if count >= 4 && matches!(formation, CastFormation::Staggered | CastFormation::Close) {
        let overlap = if formation == CastFormation::Close { 0.08 } else { 0.02 };
        let mut front = row_unit_boxes(2, 0.46, if count == 4 { 0.02 } else { 0.14 }, 1.0, if count == 4 { 0.98 } else { 0.86 }, overlap);
        let rear = row_unit_boxes(count - 2, 0.02, if count == 4 { 0.18 } else { 0.01 }, 0.58, if count == 4 { 0.82 } else { 0.99 }, overlap);
        front.extend(rear);
        return front;
    }
    if formation == CastFormation::Close && count >= 2 {
        let (left, right, overlap) = if count == 2 { (0.04, 0.96, 0.12) } else { (0.02, 0.98, 0.08) };
        return row_unit_boxes(count, 0.0, left, 1.0, right, overlap);
    }
    row_unit_boxes(count, 0.0, 0.01, 1.0, 0.99, 0.0)
}

fn lower_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => format!("{}{}", c.to_lowercase(), chars.as_str()),
        None => String::new(),
    }
}

fn upper_first(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

fn format_outfit_clause(raw: &str) -> String {
    let cleaned = clean_cast_prose(raw).trim_end_matches(['.', '!', '?']).trim().to_owned();
    if cleaned.is_empty() {
        return String::new();
    }
    if RE_OUTFIT_VERB.is_match(&cleaned) {
        return lower_first(&cleaned);
    }
    let body = if cleaned.starts_with("A ") || cleaned.starts_with("An ") || cleaned.starts_with("The ") {
        lower_first(&cleaned)
    } else {
        cleaned
    };
    format!("wearing {body}")
}

fn strip_leading_reference_subject(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let replaced = RE_LEAD_WRAP.replace(trimmed, |cap: &regex::Captures<'_>| {
        if cap[2].eq_ignore_ascii_case("wrapped") {
            format!("wrapped in a {}, ", &cap[1])
        } else {
            format!("in a {}, ", &cap[1])
        }
    });
    let stripped = RE_LEAD_SUBJ.replace(&replaced, "");
    let mid_clean = RE_MID_SUBJ.replace_all(&stripped, "$1");
    mid_clean.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ',' | ';')).trim().to_owned()
}

fn extract_reference_outfit_and_pose(raw: &str) -> (String, String) {
    let text = strip_leading_reference_subject(&clean_cast_prose(raw));
    if text.is_empty() {
        return (String::new(), String::new());
    }
    if let Some(cap) = RE_REF_VERB_OUTFIT.captures(&text)
        && let (Some(full), Some(inner)) = (cap.get(0), cap.get(1))
    {
        let mut clause = inner.as_str().trim().to_owned();
        let mut tail = String::new();
        if let Some(rest) = RE_REF_AFTER_CLOTHES.find(&clause)
            && rest.start() > 0
        {
            tail = clause[rest.start()..].to_owned();
            clause = clause[..rest.start()].trim().to_owned();
        }
        let sep = full.as_str().chars().next().filter(|c| matches!(c, '.' | '!' | '?' | ';')).map(|c| c.to_string()).unwrap_or_default();
        let pose = clean_cast_prose(&format!("{}{sep} {tail} {}", &text[..full.start()], &text[full.end()..]));
        return (format_outfit_clause(&clause), pose);
    }
    if let Some(cap) = RE_REF_IN_OUTFIT.captures(&text)
        && let (Some(full), Some(inner)) = (cap.get(0), cap.get(1))
    {
        let outfit = format_outfit_clause(&format!("wearing {}", inner.as_str().trim()));
        let end = if full.as_str().ends_with(|c: char| c.is_ascii_alphabetic()) {
            inner.end()
        } else {
            full.end()
        };
        let pose = clean_cast_prose(&text[end..]);
        return (outfit, pose);
    }
    if let Some(cap) = RE_REF_STATE_OUTFIT.captures(&text)
        && let (Some(full), Some(inner)) = (cap.get(0), cap.get(1))
    {
        let pose = clean_cast_prose(&format!("{} {}", &text[..full.start()], &text[full.end()..]));
        return (inner.as_str().trim().to_ascii_lowercase(), pose);
    }
    (String::new(), text)
}

fn box_area(b: [f64; 4]) -> f64 {
    (b[2] - b[0]).max(0.0) * (b[3] - b[1]).max(0.0)
}

fn spatial_slot_label(index: usize, count: usize, box4: [f64; 4], all: &[[f64; 4]], formation: CastFormation, use_reference: bool) -> String {
    if count <= 1 {
        return String::new();
    }
    if !use_reference && count >= 4 && formation == CastFormation::Staggered {
        return match (count, index) {
            (_, 0) => "In the front left",
            (_, 1) => "In the front right",
            (4, 2) => "In the back left",
            (4, 3) => "In the back right",
            (_, 2) => "In the back left",
            (_, 3) => "In the back center",
            _ => "In the back right",
        }.to_owned();
    }
    let base = match count {
        2 => if index == 0 { "On the left" } else { "On the right" },
        3 => match index { 0 => "On the left", 1 => "In the center", _ => "On the right" },
        4 => match index { 0 => "On the far left", 1 => "In the center-left", 2 => "In the center-right", _ => "On the far right" },
        _ => match index { 0 => "On the far left", 1 => "In the left-center", 2 => "In the center", 3 => "In the right-center", _ => "On the far right" },
    };
    if !use_reference || all.len() < 2 {
        return base.to_owned();
    }
    let my_area = box_area(box4);
    let max_area = all.iter().map(|b| box_area(*b)).fold(0.0_f64, f64::max);
    let min_area = all.iter().map(|b| box_area(*b)).fold(f64::INFINITY, f64::min);
    if max_area >= min_area * 2.5 {
        if my_area >= max_area * 0.72 {
            return format!("{base} foreground");
        }
        if my_area <= max_area * 0.35 {
            return format!("{base} background");
        }
    }
    base.to_owned()
}

fn concise_actor_summary(subject: &MossCastSubject, slot: &str, local_ref: &str) -> String {
    let identity = clean_cast_prose(if subject.identity_caption.is_empty() { &subject.caption } else { &subject.identity_caption });
    let identity = identity.trim_end_matches(['.', '!', '?']).trim();
    let name = if subject.name.trim().is_empty() { "character" } else { subject.name.trim() };
    let short_trait = RE_TRAITS
        .captures(identity)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().split(',').map(str::trim).filter(|s| !s.is_empty()).take(2).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    let who = if short_trait.is_empty() { name.to_owned() } else { format!("{name} ({short_trait})") };
    let outfit = if subject.outfit_explicit {
        format_outfit_clause(&subject.outfit_caption)
    } else if !local_ref.is_empty() {
        let (ref_outfit, ref_pose) = extract_reference_outfit_and_pose(local_ref);
        if !ref_outfit.is_empty() {
            ref_outfit
        } else {
            ref_pose.split(['.', ';']).next().unwrap_or("").trim().to_owned()
        }
    } else {
        format_outfit_clause(&subject.outfit_caption)
    };
    let prefix = if slot.is_empty() { String::new() } else { format!("{}, ", lower_first(slot)) };
    if outfit.is_empty() { format!("{prefix}{who}") } else { format!("{prefix}{who} {outfit}") }
}

fn build_actor_item_caption(subject: &MossCastSubject, slot: &str, local_caption: &str, use_reference: bool) -> String {
    let (ref_outfit, ref_pose) = if use_reference && !local_caption.is_empty() {
        extract_reference_outfit_and_pose(local_caption)
    } else {
        (String::new(), String::new())
    };
    let pose = if use_reference {
        if subject.outfit_explicit { strip_leading_reference_subject(&clean_cast_prose(local_caption)) } else { ref_pose }
    } else {
        String::new()
    };
    build_actor_item_caption_structured(subject, slot, &ref_outfit, &pose, use_reference)
}

fn build_actor_item_caption_structured(subject: &MossCastSubject, slot: &str, ref_outfit: &str, ref_pose: &str, use_reference: bool) -> String {
    let identity = clean_cast_prose(if subject.identity_caption.is_empty() { &subject.caption } else { &subject.identity_caption });
    let identity = identity.trim_end_matches(['.', '!', '?']).trim();
    let outfit = if !use_reference || subject.outfit_explicit {
        format_outfit_clause(&subject.outfit_caption)
    } else {
        ref_outfit.to_owned()
    };
    let action = clean_cast_prose(&subject.action).trim_end_matches(['.', '!', '?']).trim().to_owned();
    let head = [identity, outfit.as_str()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ");
    let mut sentences = Vec::new();
    if !head.is_empty() {
        let prefixed = if slot.is_empty() { head } else { format!("{slot}: {head}") };
        sentences.push(ensure_sentence(&prefixed));
    }
    if !ref_pose.is_empty() { sentences.push(ensure_sentence(&upper_first(ref_pose))); }
    if !action.is_empty() { sentences.push(ensure_sentence(&upper_first(&action))); }
    if sentences.is_empty() { "Character in this position.".to_owned() } else { sentences.join(" ") }
}

pub(super) fn build_moss_cast_layout(
    subjects: &[MossCastSubject],
    width: u64,
    height: u64,
    formation: CastFormation,
    reference: Option<&ParsedReferenceLayout>,
    identity_terms: &[String],
    common_caption_parts: Vec<String>,
) -> Result<String> {
    let ref_chars: Vec<(usize, &NormalizedRefItem)> = reference
        .into_iter()
        .flat_map(|layout| layout.items.iter().enumerate())
        .filter(|(_, item)| item.label == "character")
        .collect();
    let has_custom_bbox = subjects.iter().any(|subject| subject.custom_bbox.is_some());
    let use_reference = !has_custom_bbox && ref_chars.len() >= subjects.len();

    let to_local = |item: &NormalizedRefItem, replace_outfit: bool| {
        clean_cast_prose(&clean_moss_reference_prose(&item.caption, identity_terms, replace_outfit))
    };
    let make_item = |label: &str, caption: String, bbox: [i64; 4], text: Option<&str>| {
        let mut map = serde_json::Map::new();
        map.insert("label".into(), json!(label));
        map.insert("caption".into(), json!(caption));
        map.insert("bbox".into(), json!(bbox));
        if let Some(text) = text { map.insert("text".into(), json!(text)); }
        Value::Object(map)
    };

    let mut supplemental = Vec::new();
    if let Some(layout) = reference {
        for item in &layout.items {
            if item.label == "text" {
                let caption = to_local(item, false);
                supplemental.push(make_item(
                    "text",
                    if caption.is_empty() { "Visible lettering.".to_owned() } else { caption },
                    moss_normalized_box(width, height, item.bbox),
                    item.text.as_deref(),
                ));
            } else if use_reference && item.label == "object" {
                let caption = to_local(item, false);
                supplemental.push(make_item(
                    "object",
                    if caption.is_empty() { "Reference prop.".to_owned() } else { caption },
                    moss_normalized_box(width, height, item.bbox),
                    None,
                ));
            }
        }
    }

    let mut summary_entries = Vec::new();
    let (items, canvas, extra_people) = if use_reference {
        let mut by_area = ref_chars.clone();
        by_area.sort_by(|(_, a), (_, b)| box_area(b.bbox).total_cmp(&box_area(a.bbox)));
        let target_indices: HashSet<usize> = by_area.into_iter().take(subjects.len()).map(|(i, _)| i).collect();

        let mut by_x = ref_chars.clone();
        by_x.sort_by(|(_, a), (_, b)| ((a.bbox[1] + a.bbox[3]) / 2.0).total_cmp(&((b.bbox[1] + b.bbox[3]) / 2.0)));
        let target_boxes: Vec<[f64; 4]> = by_x.iter().filter(|(i, _)| target_indices.contains(i)).map(|(_, it)| it.bbox).collect();

        let mut actor_idx = 0;
        let mut out_items = Vec::new();
        for (index, item) in by_x {
            let caption = if target_indices.contains(&index) {
                let subject = &subjects[actor_idx];
                let slot = spatial_slot_label(actor_idx, subjects.len(), item.bbox, &target_boxes, formation, true);
                actor_idx += 1;
                let structured_clothing = item.clothing.as_deref().map(|c| format_outfit_clause(&clean_moss_reference_prose(c, identity_terms, false))).unwrap_or_default();
                let structured_pose = item.pose.as_deref().map(|p| strip_leading_reference_subject(&clean_moss_reference_prose(p, identity_terms, true))).unwrap_or_default();
                let has_structured = !structured_clothing.is_empty() || !structured_pose.is_empty();
                if has_structured {
                    let ref_outfit = if subject.outfit_explicit { String::new() } else { structured_clothing };
                    summary_entries.push(concise_actor_summary(subject, &slot, &ref_outfit));
                    build_actor_item_caption_structured(subject, &slot, &ref_outfit, &structured_pose, true)
                } else {
                    let local = to_local(item, subject.outfit_explicit);
                    summary_entries.push(concise_actor_summary(subject, &slot, if subject.outfit_explicit { "" } else { &local }));
                    build_actor_item_caption(subject, &slot, &local, true)
                }
            } else {
                let local = to_local(item, false);
                if local.is_empty() { "Supporting character in this position.".to_owned() } else { local }
            };
            out_items.push(make_item("character", caption, moss_normalized_box(width, height, item.bbox), None));
        }
        let room = MAX_LAYOUT_ITEMS.saturating_sub(out_items.len());
        out_items.extend(supplemental.into_iter().take(room));
        (out_items, reference.map(|r| r.canvas.clone()).unwrap_or_else(|| "single".to_owned()), ref_chars.len().saturating_sub(subjects.len()))
    } else {
        let default_units = moss_cast_unit_boxes(subjects.len(), formation);
        let unit_boxes: Vec<[f64; 4]> = subjects.iter().zip(&default_units).map(|(s, d)| s.custom_bbox.unwrap_or(*d)).collect();
        let mut out_items: Vec<Value> = subjects
            .iter()
            .enumerate()
            .map(|(idx, subject)| {
                let slot = spatial_slot_label(idx, subjects.len(), unit_boxes[idx], &unit_boxes, formation, false);
                summary_entries.push(concise_actor_summary(subject, &slot, ""));
                make_item(
                    "character",
                    build_actor_item_caption(subject, &slot, "", false),
                    moss_normalized_box(width, height, unit_boxes[idx]),
                    None,
                )
            })
            .collect();
        let room = MAX_LAYOUT_ITEMS.saturating_sub(out_items.len());
        out_items.extend(supplemental.into_iter().take(room));
        (out_items, "single".to_owned(), 0)
    };

    let mut summary_lines = Vec::new();
    let mut seen_lines = HashSet::new();
    let total_count = subjects.len() + extra_people;
    if subjects.len() >= 2 {
        let anchor = format!(
            "Exactly {total_count} distinct characters appear in the scene, each keeping their own distinct hair, eyes, and outfit: {}.",
            summary_entries.join("; ")
        );
        seen_lines.insert(anchor.clone());
        summary_lines.push(anchor);
    }
    if extra_people == 1 {
        let line = "One additional supporting character appears in the frame.".to_owned();
        if seen_lines.insert(line.clone()) { summary_lines.push(line); }
    } else if extra_people > 1 {
        let line = format!("{extra_people} additional supporting characters appear in the frame.");
        if seen_lines.insert(line.clone()) { summary_lines.push(line); }
    }
    for part in common_caption_parts {
        let cleaned = clean_cast_prose(&part);
        if !cleaned.is_empty() && seen_lines.insert(cleaned.clone()) {
            summary_lines.push(cleaned);
        }
    }
    let summary_caption = if summary_lines.is_empty() { "Group portrait.".to_owned() } else { summary_lines.join("\n") };

    let rendered = serde_json::to_string_pretty(&json!({
        "summary": { "canvas": canvas, "caption": summary_caption },
        "items": items,
        "bbox_coord_space": "abs_centralized",
        "bbox_format": "yxyx",
    }))?;
    if rendered.encode_utf16().count() > MAX_PROMPT_UTF16 {
        return Err(ApiError::invalid("编译后的 MOSS 多人布局 JSON 超过 12000 字符上限，请精简场景或角色动作描述"));
    }
    Ok(rendered)
}
