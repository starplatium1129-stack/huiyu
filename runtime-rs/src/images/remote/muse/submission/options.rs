use super::super::*;
use super::{MOSS_PREVIEW_SETTINGS, SceneSelection, Upscale};

pub(in super::super) fn apply_upscale(
    payload: &mut Value,
    family: &str,
    upscale: Option<Upscale>,
) -> Result<()> {
    let Some(upscale) = upscale else {
        return Ok(());
    };
    let name = match upscale {
        Upscale::Off => {
            if family == "anima" {
                payload["hiresFix"] = json!(false);
            }
            return Ok(());
        }
        Upscale::UltraSharp => "4x-UltraSharp",
        Upscale::Remacri => "Remacri",
    };
    if family != "anima" {
        return Err(ApiError::invalid(
            "UltraSharp 和 Remacri 随出图放大仅适用于 Anima",
        ));
    }
    payload["hiresFix"] = json!(true);
    payload["hiresUpscaler"] = json!(name);
    payload["hiresScale"] = json!(1.5);
    // The native Anima backend uses Euler/Normal with shift 3 for UltraSharp.
    payload["hiresDenoise"] = json!(0.8);
    payload["hiresSteps"] = json!(10);
    payload["hiresCfg"] = json!(5.5);
    Ok(())
}

pub(super) fn check_uploaded_name(name: &str, field: &str) -> Result<()> {
    if !inputs::valid_name(name) {
        return Err(ApiError::invalid(format!(
            "{field} 必须是 /api/{{family}}/images/raw 返回的有效已上传图像名称"
        )));
    }
    Ok(())
}

impl SceneSelection {
    pub(in super::super) fn apply_tea_cache_options(
        &self,
        payload: &mut Value,
        family: &str,
    ) -> Result<()> {
        if self.tea_cache.is_none() && self.tea_cache_thresh.is_none() {
            return Ok(());
        }
        if family != "anima" {
            return Err(ApiError::invalid("TeaCache 开关和阈值仅适用于 Anima"));
        }
        if let Some(enabled) = self.tea_cache {
            payload["teaCache"] = json!(enabled);
        }
        if let Some(threshold) = self.tea_cache_thresh {
            payload["teaCacheThresh"] =
                validation::number(&json!(threshold), "teaCacheThresh", 0., 1., false)?;
        }
        Ok(())
    }

    pub(in super::super) fn apply_moss_options(
        &self,
        payload: &mut Value,
        family: &str,
    ) -> Result<()> {
        if family != "moss-image"
            && (self.moss_sampler.is_some()
                || self.moss_acceleration.is_some()
                || self.moss_spectrum_flex_window.is_some())
        {
            return Err(ApiError::invalid(
                "仅 MOSS 可指定 mossSampler、mossAcceleration 和 mossSpectrumFlexWindow",
            ));
        }
        if let Some(sampler) = &self.moss_sampler {
            if sampler == "er-sde" && payload["mossSampler"] != "er-sde" {
                // Drop the bundled Euler preset. Explicit options are applied after this step.
                let fields = payload.as_object_mut().ok_or_else(unavailable)?;
                for key in MOSS_PREVIEW_SETTINGS {
                    fields.remove(key);
                }
            }
            payload["mossSampler"] = json!(sampler);
        }
        if let Some(acceleration) = &self.moss_acceleration {
            payload["mossAcceleration"] = json!(acceleration);
        }
        if let Some(window) = self.moss_spectrum_flex_window {
            payload["mossSpectrumFlexWindow"] = json!(window);
        }
        Ok(())
    }

    pub(in super::super) fn has_edit_fields(&self) -> bool {
        self.init_image.is_some()
            || self.reference_images.is_some()
            || self.denoising_strength.is_some()
            || self.mask_image.is_some()
            || self.mask_prompt.is_some()
            || self.mask_threshold.is_some()
            || self.grow_mask_by.is_some()
            || self.sketch_control.is_some()
            || self.regions.is_some()
    }

    pub(in super::super) fn has_manga_fields(&self) -> bool {
        self.operation.is_some()
            || self.pen_lines.is_some()
            || self.pen_lines_polarity.is_some()
            || self.pen_lines_fit.is_some()
            || self.auto_lines.is_some()
            || self.levels.is_some()
            || self.finish.is_some()
            || self.panel.is_some()
            || self.rewrite.is_some()
    }

    pub(in super::super) fn apply_edit_options(
        &self,
        payload: &mut Value,
        family: &str,
    ) -> Result<()> {
        if !self.has_edit_fields() {
            return Ok(());
        }
        if let Some(init) = &self.init_image {
            if !matches!(family, "anima" | "qwen-image" | "keyframe") {
                return Err(ApiError::invalid(
                    "initImage 仅适用于 Anima、Qwen-Image 和 Keyframe 模型",
                ));
            }
            check_uploaded_name(init, "initImage")?;
            payload["initImage"] = json!(init);
        }
        if let Some(references) = &self.reference_images {
            if !matches!(family, "qwen-image" | "keyframe") {
                return Err(ApiError::invalid(
                    "referenceImages 仅适用于 Qwen-Image 和 Keyframe 模型",
                ));
            }
            for name in references {
                check_uploaded_name(name, "referenceImages")?;
            }
            payload["referenceImages"] = json!(references);
        }
        if self.denoising_strength.is_some()
            || self.mask_image.is_some()
            || self.mask_prompt.is_some()
            || self.mask_threshold.is_some()
            || self.grow_mask_by.is_some()
            || self.sketch_control.is_some()
            || self.regions.is_some()
        {
            if family != "anima" {
                return Err(ApiError::invalid(
                    "denoisingStrength、maskImage、maskPrompt、maskThreshold、growMaskBy、sketchControl 和 regions 仅适用于 Anima",
                ));
            }
            if let Some(strength) = self.denoising_strength {
                if self.init_image.is_none() {
                    return Err(ApiError::invalid("denoisingStrength 需要同时提供 initImage"));
                }
                payload["denoisingStrength"] = json!(strength);
            }
            if let Some(mask) = &self.mask_image {
                check_uploaded_name(mask, "maskImage")?;
                payload["maskImage"] = json!(mask);
            }
            if let Some(mask_prompt) = &self.mask_prompt {
                payload["maskPrompt"] = json!(mask_prompt);
            }
            if let Some(threshold) = self.mask_threshold {
                payload["maskThreshold"] = json!(threshold);
            }
            if let Some(grow) = self.grow_mask_by {
                payload["growMaskBy"] = json!(grow);
            }
            if let Some(sketch) = &self.sketch_control {
                if let Some(name) = sketch["image"].as_str() {
                    check_uploaded_name(name, "sketchControl.image")?;
                }
                payload["sketchControl"] = sketch.clone();
            }
            if let Some(regions) = &self.regions {
                payload["regions"] = json!(regions);
            }
        }
        Ok(())
    }

    pub(in super::super) fn has_cast(&self) -> bool {
        self.cast.is_some()
            || self.formation.is_some()
            || self.interaction.is_some()
            || self.reference_caption.is_some()
            || self.reference_tags.is_some()
            || self.reference_identity_terms.is_some()
    }

    pub(in super::super) fn is_custom(&self) -> bool {
        self.prompt.is_some()
            || self.layout.is_some()
            || matches!(self.kind.as_deref(), Some("prompt" | "manga"))
            || self.model_id.as_deref() == Some("manga-screen")
    }

    pub(in super::super) fn uses_prompt_only_fields(&self) -> bool {
        self.negative.is_some()
            || self.steps.is_some()
            || self.cfg.is_some()
            || self.character.is_some()
            || self.lora_id.is_some()
            || self.lora_strength.is_some()
            || self.layout.is_some()
            || self.reference_images.is_some()
            || self.has_cast()
            || self.has_manga_fields()
    }
}
