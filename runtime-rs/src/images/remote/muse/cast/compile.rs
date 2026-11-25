use super::clean::{
    CastFormation, clean_cast_negative, conflicts_with_fair_skin, ensure_sentence, join_sentences,
    normalize_key, public_tags, unique_tags,
};
use super::layout_bind::{MossCastSubject, build_moss_cast_layout};
use super::ref_layout::ParsedReferenceLayout;
use super::{ResolvedActor, SceneContext};
use super::super::*;
use std::collections::HashSet;

const ANIMA_DEFAULT_QUALITY: &[&str] = &[
    "masterpiece",
    "best quality",
    "very aesthetic",
    "newest",
    "absurdres",
    "highres",
];
const MOSS_DEFAULT_NEGATIVE: &str = "extra toes, lowres, (bad), text, error, fewer, extra, missing, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, oldest, early, signature, artistic error, username, bad feet, scan, [abstract], english text, shiny hair";

pub(super) struct CompileContext<'a> {
    pub(super) family: &'a str,
    pub(super) width: u64,
    pub(super) height: u64,
    pub(super) formation: CastFormation,
    pub(super) actors: &'a [ResolvedActor],
    pub(super) scene_ctx: Option<&'a SceneContext>,
    pub(super) parsed_ref_layout: Option<&'a ParsedReferenceLayout>,
    pub(super) identity_terms: &'a [String],
    pub(super) shared_scene_tags: &'a [String],
    pub(super) count_tags: &'a [String],
    pub(super) user_prompt_clean: &'a str,
    pub(super) scene_prose_clean: &'a str,
    pub(super) ref_caption_clean: &'a str,
    pub(super) user_negative: Option<&'a str>,
}

pub(super) fn compile_family_prompt(ctx: &CompileContext<'_>) -> Result<(String, Option<String>)> {
    match ctx.family {
        "moss-image" => compile_moss(ctx),
        "anima" => Ok(compile_anima(ctx)),
        _ => Ok(compile_natural(ctx)),
    }
}

fn compile_moss(ctx: &CompileContext<'_>) -> Result<(String, Option<String>)> {
    let subjects: Vec<MossCastSubject> = ctx
        .actors
        .iter()
        .map(|actor| {
            let full_caption = [
                actor.identity_caption.as_str(),
                actor.outfit_caption.as_str(),
                actor.action.as_str(),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
            MossCastSubject {
                caption: full_caption,
                identity_caption: actor.identity_caption.clone(),
                outfit_caption: actor.outfit_caption.clone(),
                outfit_explicit: actor.outfit_explicit,
                action: actor.action.clone(),
            }
        })
        .collect();

    let mut common_parts = Vec::new();
    if !ctx.user_prompt_clean.is_empty() {
        common_parts.push(ctx.user_prompt_clean.to_owned());
    }
    if !ctx.scene_prose_clean.is_empty() {
        common_parts.push(ctx.scene_prose_clean.to_owned());
    }
    if !ctx.ref_caption_clean.is_empty() && ctx.ref_caption_clean != ctx.user_prompt_clean {
        common_parts.push(ctx.ref_caption_clean.to_owned());
    }
    let mut summary_tags = ctx.count_tags.to_vec();
    summary_tags.extend(ctx.shared_scene_tags.iter().map(|t| t.replace('_', " ")));
    if !summary_tags.is_empty() {
        common_parts.push(unique_tags(summary_tags).join(", "));
    }

    let prompt_json = build_moss_cast_layout(
        &subjects,
        ctx.width,
        ctx.height,
        ctx.formation,
        ctx.parsed_ref_layout,
        ctx.identity_terms,
        common_parts,
    )?;
    let neg = match ctx.user_negative {
        Some(custom_neg) => clean_cast_negative(custom_neg),
        None => clean_cast_negative(MOSS_DEFAULT_NEGATIVE),
    };
    Ok((prompt_json, Some(neg)))
}

fn compile_anima(ctx: &CompileContext<'_>) -> (String, Option<String>) {
    let character_tokens = unique_tags(
        ctx.actors
            .iter()
            .flat_map(|actor| actor.character_tokens.iter().cloned()),
    );
    let copyright_tokens = unique_tags(
        ctx.actors
            .iter()
            .flat_map(|actor| actor.copyright_tokens.iter().cloned()),
    );
    let shared_identity_keys: HashSet<String> = character_tokens
        .iter()
        .chain(copyright_tokens.iter())
        .map(|t| normalize_key(t))
        .collect();

    let has_dark_skin = ctx
        .actors
        .iter()
        .flat_map(|actor| actor.identity_tokens.iter())
        .any(|token| conflicts_with_fair_skin(token))
        || conflicts_with_fair_skin(ctx.user_prompt_clean);

    let mut head = Vec::new();
    for q in ANIMA_DEFAULT_QUALITY {
        if !has_dark_skin || normalize_key(q) != "fair skin" {
            head.push((*q).to_owned());
        }
    }
    head.extend(ctx.count_tags.iter().cloned());
    head.extend(character_tokens.iter().cloned());
    head.extend(copyright_tokens.iter().cloned());
    head.extend(ctx.shared_scene_tags.iter().cloned());
    head.extend(public_tags(&[ctx.user_prompt_clean]));
    let shared_head = unique_tags(head).join(", ");

    let mut sections = vec![shared_head];
    for actor in ctx.actors {
        let mut block = Vec::new();
        for token in &actor.identity_tokens {
            if !shared_identity_keys.contains(&normalize_key(token)) {
                block.push(token.clone());
            }
        }
        block.extend(actor.outfit_tokens.iter().cloned());
        if !actor.action.is_empty() {
            block.extend(public_tags(&[&actor.action]));
        }
        let joined = unique_tags(block).join(", ");
        if !joined.is_empty() {
            sections.push(joined);
        }
    }
    let tags_line = sections.join(" BREAK ");
    let direction_list = ctx
        .actors
        .iter()
        .map(|actor| {
            if actor.action.is_empty() {
                actor.name.clone()
            } else {
                format!("{} — {}", actor.name, actor.action)
            }
        })
        .collect::<Vec<_>>()
        .join("; ");
    let direction = format!(
        "From left to right: {}.",
        direction_list.trim_end_matches(['.', '!', '?'])
    );
    let mut lines = vec![tags_line];
    if !ctx.scene_prose_clean.is_empty() {
        lines.push(ensure_sentence(ctx.scene_prose_clean));
    }
    lines.push(direction);
    let neg = ctx.user_negative.map(clean_cast_negative);
    (lines.join("\n"), neg)
}

fn compile_natural(ctx: &CompileContext<'_>) -> (String, Option<String>) {
    let mut sentences = Vec::new();
    if ctx.actors.len() > 1 {
        let names = ctx
            .actors
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let layout_hint = if ctx.actors.len() >= 4 && ctx.formation == CastFormation::Staggered {
            "in a staggered two-row group composition"
        } else {
            "side by side in the same frame"
        };
        sentences.push(format!(
            "Group illustration featuring {} characters ({names}) {layout_hint}",
            ctx.actors.len()
        ));
    }
    for actor in ctx.actors {
        let mut parts = vec![actor.identity_caption.clone()];
        if !actor.outfit_caption.is_empty() {
            parts.push(actor.outfit_caption.clone());
        }
        if !actor.action.is_empty() {
            parts.push(actor.action.clone());
        }
        sentences.push(join_sentences(parts));
    }
    if !ctx.user_prompt_clean.is_empty() {
        sentences.push(ctx.user_prompt_clean.to_owned());
    }
    if !ctx.scene_prose_clean.is_empty() {
        sentences.push(ctx.scene_prose_clean.to_owned());
    }
    if let Some(scene) = ctx.scene_ctx
        && !scene.camera.is_empty()
        && scene.camera.is_ascii()
    {
        sentences.push(format!("Camera framing: {}", scene.camera));
    }
    if ctx.actors.len() > 1 {
        let order = ctx
            .actors
            .iter()
            .map(|a| a.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        sentences.push(format!("Arranged from left to right: {order}"));
    }
    let prompt = join_sentences(sentences);
    let neg = ctx.user_negative.map(clean_cast_negative);
    (prompt, neg)
}
