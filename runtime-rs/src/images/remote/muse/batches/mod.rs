mod enqueue;
mod lifecycle;

use super::*;

pub(super) const MAX_BATCH: usize = 16;
const MAX_WAITING: i64 = 64;

pub(super) use enqueue::{create, enqueue, enqueue_prepared};
pub(super) use lifecycle::{cancel_batch, cancel_item, dispatch, item_status, status, view};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Batch {
    pub(super) request_key: String,
    model_id: Option<String>,
    variants: Option<u8>,
    seed: Option<u64>,
    width: Option<u64>,
    height: Option<u64>,
    upscale: Option<submission::Upscale>,
    tea_cache: Option<bool>,
    tea_cache_thresh: Option<f64>,
    moss_sampler: Option<String>,
    moss_acceleration: Option<String>,
    moss_spectrum_flex_window: Option<f64>,
    #[serde(alias = "imageId")]
    init_image: Option<String>,
    reference_images: Option<Vec<String>>,
    denoising_strength: Option<f64>,
    mask_image: Option<String>,
    mask_prompt: Option<String>,
    mask_threshold: Option<f64>,
    grow_mask_by: Option<u64>,
    style_lora_id: Option<String>,
    sketch_control: Option<Value>,
    regions: Option<Vec<Value>>,
    layout: Option<Value>,
    cast: Option<Vec<cast::CastMemberInput>>,
    #[serde(alias = "castFormation")]
    formation: Option<String>,
    #[serde(alias = "sceneInteraction", alias = "relations", alias = "relation")]
    interaction: Option<cast::InteractionInput>,
    reference_caption: Option<String>,
    reference_tags: Option<Vec<String>>,
    reference_layout: Option<Value>,
    reference_identity_terms: Option<Vec<String>>,
    #[serde(default, alias = "items")]
    scenes: Vec<SceneSelection>,
    #[serde(default)]
    ids: Vec<String>,
}

impl Batch {
    pub(super) fn selections(mut self) -> Result<(Option<String>, Vec<SceneSelection>)> {
        if !self.ids.is_empty() && !self.scenes.is_empty() {
            return Err(ApiError::invalid(
                "请用 ids 提交目录 ID，或用 items 为每项指定参数",
            ));
        }
        self.scenes
            .extend(self.ids.into_iter().map(|id| SceneSelection {
                id: Some(id),
                ..Default::default()
            }));
        let default_size = submission::dimensions(self.width, self.height)?;
        for scene in &mut self.scenes {
            scene.variants = scene.variants.or(self.variants);
            scene.seed = scene.seed.or(self.seed);
            scene.upscale = scene.upscale.or(self.upscale);
            scene.tea_cache = scene.tea_cache.or(self.tea_cache);
            scene.tea_cache_thresh = scene.tea_cache_thresh.or(self.tea_cache_thresh);
            if scene.moss_sampler.is_none() {
                scene.moss_sampler.clone_from(&self.moss_sampler);
            }
            if scene.moss_acceleration.is_none() {
                scene.moss_acceleration.clone_from(&self.moss_acceleration);
            }
            scene.moss_spectrum_flex_window = scene
                .moss_spectrum_flex_window
                .or(self.moss_spectrum_flex_window);
            if scene.init_image.is_none() {
                scene.init_image.clone_from(&self.init_image);
            }
            if scene.reference_images.is_none() {
                scene.reference_images.clone_from(&self.reference_images);
            }
            scene.denoising_strength = scene.denoising_strength.or(self.denoising_strength);
            if scene.mask_image.is_none() {
                scene.mask_image.clone_from(&self.mask_image);
            }
            if scene.mask_prompt.is_none() {
                scene.mask_prompt.clone_from(&self.mask_prompt);
            }
            scene.mask_threshold = scene.mask_threshold.or(self.mask_threshold);
            scene.grow_mask_by = scene.grow_mask_by.or(self.grow_mask_by);
            if scene.style_lora_id.is_none() {
                scene.style_lora_id.clone_from(&self.style_lora_id);
            }
            if scene.sketch_control.is_none() {
                scene.sketch_control.clone_from(&self.sketch_control);
            }
            if scene.regions.is_none() {
                scene.regions.clone_from(&self.regions);
            }
            if scene.layout.is_none() {
                scene.layout.clone_from(&self.layout);
            }
            if scene.cast.is_none() {
                scene.cast.clone_from(&self.cast);
            }
            if scene.formation.is_none() {
                scene.formation.clone_from(&self.formation);
            }
            if scene.interaction.is_none() {
                scene.interaction.clone_from(&self.interaction);
            }
            if scene.reference_caption.is_none() {
                scene.reference_caption.clone_from(&self.reference_caption);
            }
            if scene.reference_tags.is_none() {
                scene.reference_tags.clone_from(&self.reference_tags);
            }
            if scene.reference_layout.is_none() {
                scene.reference_layout.clone_from(&self.reference_layout);
            }
            if scene.reference_identity_terms.is_none() {
                scene.reference_identity_terms.clone_from(&self.reference_identity_terms);
            }
            if scene.width.is_none()
                && scene.height.is_none()
                && let Some((width, height)) = default_size
            {
                scene.width = Some(width);
                scene.height = Some(height);
            }
        }
        Ok((self.model_id, self.scenes))
    }
}
