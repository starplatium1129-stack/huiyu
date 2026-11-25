use super::clean::{CastFormation, clean_cast_prose, clean_moss_reference_prose};
use super::ref_layout::{NormalizedRefItem, ParsedReferenceLayout};
use super::super::*;
use std::collections::HashSet;

const MAX_LAYOUT_ITEMS: usize = 16;
const MAX_PROMPT_UTF16: usize = 12_000;

pub(super) struct MossCastSubject {
    pub(super) caption: String,
    pub(super) identity_caption: String,
    pub(super) outfit_caption: String,
    pub(super) outfit_explicit: bool,
    pub(super) action: String,
}

pub(super) fn moss_normalized_box(width: u64, height: u64, [y1, x1, y2, x2]: [f64; 4]) -> [i64; 4] {
    let w = width as f64;
    let h = height as f64;
    let half_w = w / 2.0;
    let half_h = h / 2.0;
    let min_y = (-half_h).ceil() as i64;
    let max_y = half_h.floor() as i64;
    let min_x = (-half_w).ceil() as i64;
    let max_x = half_w.floor() as i64;
    let clamp01 = |n: f64| if n.is_finite() { n.clamp(0.0, 1.0) } else { 0.0 };
    let clamp_int = |v: f64, lo: i64, hi: i64| (v.round() as i64).clamp(lo, hi);

    let ny1 = clamp01(y1);
    let nx1 = clamp01(x1);
    let ny2 = clamp01(y2);
    let nx2 = clamp01(x2);

    let mut top = clamp_int(ny1 * h - half_h, min_y, max_y - 1);
    let mut bottom = clamp_int(ny2 * h - half_h, min_y + 1, max_y);
    if bottom <= top {
        if top < max_y {
            bottom = top + 1;
        } else {
            top = bottom - 1;
        }
    }
    let mut left = clamp_int(nx1 * w - half_w, min_x, max_x - 1);
    let mut right = clamp_int(nx2 * w - half_w, min_x + 1, max_x);
    if right <= left {
        if left < max_x {
            right = left + 1;
        } else {
            left = right - 1;
        }
    }
    [top, left, bottom, right]
}

fn row_boxes(
    width: u64,
    height: u64,
    length: usize,
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
    overlap: f64,
) -> Vec<[i64; 4]> {
    let n = length as f64;
    let span = (right - left) / (n - overlap * (n - 1.0));
    (0..length)
        .map(|index| {
            let start = left + (index as f64) * span * (1.0 - overlap);
            moss_normalized_box(width, height, [top, start, bottom, start + span])
        })
        .collect()
}

pub(super) fn moss_cast_boxes(
    width: u64,
    height: u64,
    count: usize,
    formation: CastFormation,
) -> Vec<[i64; 4]> {
    if count >= 4 && formation == CastFormation::Staggered {
        let mut front = row_boxes(
            width,
            height,
            2,
            0.42,
            if count == 4 { 0.01 } else { 0.14 },
            1.0,
            if count == 4 { 0.99 } else { 0.86 },
            0.12,
        );
        let rear = row_boxes(
            width,
            height,
            count - 2,
            0.02,
            if count == 4 { 0.19 } else { 0.01 },
            0.67,
            if count == 4 { 0.81 } else { 0.99 },
            0.12,
        );
        front.extend(rear);
        return front;
    }
    row_boxes(width, height, count, 0.0, 0.0, 1.0, 1.0, 0.12)
}

fn with_local_reference(subject: &MossCastSubject, local_caption: &str) -> String {
    let parts = if !subject.identity_caption.is_empty() {
        vec![
            subject.identity_caption.as_str(),
            if subject.outfit_explicit {
                subject.outfit_caption.as_str()
            } else {
                ""
            },
            local_caption,
            subject.action.as_str(),
        ]
    } else {
        vec![subject.caption.as_str(), local_caption]
    };
    let joined = parts
        .into_iter()
        .map(clean_cast_prose)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if joined.is_empty() {
        "Character in this position.".to_owned()
    } else {
        joined
    }
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
    let use_reference = ref_chars.len() >= subjects.len();

    let to_local = |item: &NormalizedRefItem, replace_outfit: bool| {
        clean_cast_prose(&clean_moss_reference_prose(
            &item.caption,
            identity_terms,
            replace_outfit,
        ))
    };
    let make_item = |label: &str, caption: String, bbox: [i64; 4], text: Option<&str>| {
        let mut map = serde_json::Map::new();
        map.insert("label".into(), json!(label));
        map.insert("caption".into(), json!(caption));
        map.insert("bbox".into(), json!(bbox));
        if let Some(text) = text {
            map.insert("text".into(), json!(text));
        }
        Value::Object(map)
    };

    let mut supplemental = Vec::new();
    if let Some(layout) = reference {
        for item in &layout.items {
            if item.label == "text" {
                let caption = to_local(item, false);
                supplemental.push(make_item(
                    "text",
                    if caption.is_empty() {
                        "Visible lettering.".to_owned()
                    } else {
                        caption
                    },
                    moss_normalized_box(width, height, item.bbox),
                    item.text.as_deref(),
                ));
            } else if use_reference && item.label == "object" {
                let caption = to_local(item, false);
                supplemental.push(make_item(
                    "object",
                    if caption.is_empty() {
                        "Reference prop.".to_owned()
                    } else {
                        caption
                    },
                    moss_normalized_box(width, height, item.bbox),
                    None,
                ));
            }
        }
    }

    let (items, canvas, extra_people) = if use_reference {
        let mut by_area = ref_chars.clone();
        by_area.sort_by(|(_, a), (_, b)| {
            let area_a = (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]);
            let area_b = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
            area_b.total_cmp(&area_a)
        });
        let target_indices: HashSet<usize> = by_area
            .into_iter()
            .take(subjects.len())
            .map(|(index, _)| index)
            .collect();

        let mut by_x = ref_chars.clone();
        by_x.sort_by(|(_, a), (_, b)| {
            let cx_a = (a.bbox[1] + a.bbox[3]) / 2.0;
            let cx_b = (b.bbox[1] + b.bbox[3]) / 2.0;
            cx_a.total_cmp(&cx_b)
        });

        let mut actor_idx = 0;
        let mut out_items = Vec::new();
        for (index, item) in by_x {
            let caption = if target_indices.contains(&index) {
                let subject = &subjects[actor_idx];
                actor_idx += 1;
                let local = to_local(item, subject.outfit_explicit);
                with_local_reference(subject, &local)
            } else {
                let local = to_local(item, false);
                if local.is_empty() {
                    "Supporting character in this position.".to_owned()
                } else {
                    local
                }
            };
            out_items.push(make_item(
                "character",
                caption,
                moss_normalized_box(width, height, item.bbox),
                None,
            ));
        }
        let room = MAX_LAYOUT_ITEMS.saturating_sub(out_items.len());
        out_items.extend(supplemental.into_iter().take(room));
        (
            out_items,
            reference
                .map(|r| r.canvas.clone())
                .unwrap_or_else(|| "single".to_owned()),
            ref_chars.len().saturating_sub(subjects.len()),
        )
    } else {
        let boxes = moss_cast_boxes(width, height, subjects.len(), formation);
        let mut out_items: Vec<Value> = subjects
            .iter()
            .zip(boxes)
            .map(|(subject, bbox)| {
                let caption = clean_cast_prose(&subject.caption);
                make_item(
                    "character",
                    if caption.is_empty() {
                        "Character in this position.".to_owned()
                    } else {
                        caption
                    },
                    bbox,
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
    if extra_people == 1 {
        let line = "One additional supporting character appears in the frame.".to_owned();
        seen_lines.insert(line.clone());
        summary_lines.push(line);
    } else if extra_people > 1 {
        let line = format!("{extra_people} additional supporting characters appear in the frame.");
        seen_lines.insert(line.clone());
        summary_lines.push(line);
    }
    for part in common_caption_parts {
        let cleaned = clean_cast_prose(&part);
        if !cleaned.is_empty() && seen_lines.insert(cleaned.clone()) {
            summary_lines.push(cleaned);
        }
    }
    let summary_caption = if summary_lines.is_empty() {
        "Group portrait.".to_owned()
    } else {
        summary_lines.join("\n")
    };

    let rendered = serde_json::to_string_pretty(&json!({
        "summary": {
            "canvas": canvas,
            "caption": summary_caption,
        },
        "items": items,
        "bbox_coord_space": "abs_centralized",
        "bbox_format": "yxyx",
    }))?;
    if rendered.encode_utf16().count() > MAX_PROMPT_UTF16 {
        return Err(ApiError::invalid(
            "编译后的 MOSS 多人布局 JSON 超过 12000 字符上限，请精简场景或角色动作描述",
        ));
    }
    Ok(rendered)
}
