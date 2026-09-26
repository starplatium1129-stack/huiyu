use std::collections::HashMap;

use live2d_native::model::Model;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MouthBinding {
    pub id: String,
    pub scale: f32,
    pub range: Option<[f32; 2]>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlaySettleConfig {
    pub settle_ms: f32,
    pub reset_defaults: HashMap<String, f32>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Live2DAdapterConfig {
    pub profile_id: String,
    pub mouth: Option<MouthBinding>,
    #[serde(default)]
    pub blink: Vec<String>,
    #[serde(default)]
    pub focus: Vec<String>,
    #[serde(default)]
    pub emotion_params: HashMap<String, HashMap<String, f32>>,
    pub overlay_settle: Option<OverlaySettleConfig>,
    pub entrance_group: Option<String>,
    pub leave_group: Option<String>,
}

impl Live2DAdapterConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_id.trim().is_empty() || self.profile_id.len() > 160 {
            return Err("invalid adapter profileId".into());
        }
        if let Some(mouth) = &self.mouth {
            validate_param_id(&mouth.id)?;
            if !mouth.scale.is_finite() {
                return Err("invalid mouth scale".into());
            }
            if let Some([min, max]) = mouth.range {
                if !min.is_finite() || !max.is_finite() || min > max {
                    return Err("invalid mouth range".into());
                }
            }
        }
        validate_param_ids(&self.blink)?;
        validate_param_ids(&self.focus)?;
        if self.emotion_params.len() > 64 {
            return Err("too many adapter emotions".into());
        }
        for (emotion, params) in &self.emotion_params {
            if emotion.is_empty() || emotion.len() > 80 || params.len() > 128 {
                return Err("invalid adapter emotion mapping".into());
            }
            for (id, value) in params {
                validate_param_id(id)?;
                if !value.is_finite() {
                    return Err("invalid adapter emotion value".into());
                }
            }
        }
        if let Some(overlay) = &self.overlay_settle {
            if !overlay.settle_ms.is_finite() || !(1.0..=10_000.0).contains(&overlay.settle_ms) {
                return Err("invalid overlay settle duration".into());
            }
            if overlay.reset_defaults.len() > 256 {
                return Err("too many overlay reset parameters".into());
            }
            for (id, value) in &overlay.reset_defaults {
                validate_param_id(id)?;
                if !value.is_finite() {
                    return Err("invalid overlay reset value".into());
                }
            }
        }
        validate_group(self.entrance_group.as_deref())?;
        validate_group(self.leave_group.as_deref())?;
        Ok(())
    }

    pub fn mouth_value(&self, level: f32) -> Option<(&str, f32)> {
        let mouth = self.mouth.as_ref()?;
        let value = (level.clamp(0.0, 1.0) * mouth.scale).clamp(
            mouth.range.map(|range| range[0]).unwrap_or(f32::MIN),
            mouth.range.map(|range| range[1]).unwrap_or(f32::MAX),
        );
        Some((&mouth.id, value))
    }

    pub fn apply_emotion(&self, model: &mut Model, name: &str, intensity: f32) {
        let intensity = intensity.clamp(0.0, 1.0);
        for (id, value) in self.emotion_params.get(name).into_iter().flatten() {
            if model.parameter_index(id).is_some() {
                model.set_parameter(id, value * intensity, 1.0);
            }
        }
    }
}

pub struct OverlaySettler {
    elapsed: f32,
    duration: f32,
    entries: Vec<(String, f32, f32)>,
}

impl OverlaySettler {
    pub fn begin(model: &Model, config: &OverlaySettleConfig) -> Option<Self> {
        let entries = config
            .reset_defaults
            .iter()
            .filter(|(id, _)| model.parameter_index(id).is_some())
            .map(|(id, target)| (id.clone(), model.get_parameter(id), *target))
            .collect::<Vec<_>>();
        (!entries.is_empty()).then_some(Self {
            elapsed: 0.0,
            duration: config.settle_ms / 1000.0,
            entries,
        })
    }

    pub fn step(&mut self, model: &mut Model, dt: f32) -> bool {
        self.elapsed = (self.elapsed + dt.max(0.0)).min(self.duration);
        let t = (self.elapsed / self.duration).clamp(0.0, 1.0);
        let eased = t * t * (3.0 - 2.0 * t);
        for (id, from, target) in &self.entries {
            model.set_parameter(id, from + (target - from) * eased, 1.0);
        }
        t < 1.0
    }
}

pub fn apply_overlay_defaults(model: &mut Model, config: &OverlaySettleConfig) {
    for (id, value) in &config.reset_defaults {
        if model.parameter_index(id).is_some() {
            model.set_parameter(id, *value, 1.0);
        }
    }
}

fn validate_param_ids(ids: &[String]) -> Result<(), String> {
    if ids.len() > 64 {
        return Err("too many adapter parameters".into());
    }
    ids.iter().try_for_each(|id| validate_param_id(id))
}

fn validate_param_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')) {
        return Err(format!("invalid adapter parameter id {id:?}"));
    }
    Ok(())
}

fn validate_group(group: Option<&str>) -> Result<(), String> {
    if group.is_some_and(|value| value.is_empty() || value.len() > 128 || value.chars().any(|c| matches!(c, '/' | '\\'))) {
        return Err("invalid adapter motion group".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouth_mapping_supports_reversed_ranges() {
        let config = Live2DAdapterConfig {
            profile_id: "fixture".into(),
            mouth: Some(MouthBinding { id: "ParamMouthCustom".into(), scale: -0.5, range: Some([-0.5, 0.0]) }),
            blink: vec![], focus: vec![], emotion_params: HashMap::new(), overlay_settle: None,
            entrance_group: None, leave_group: None,
        };
        assert_eq!(config.mouth_value(1.0), Some(("ParamMouthCustom", -0.5)));
        assert!(config.validate().is_ok());
    }

    #[test]
    fn invalid_parameter_ids_are_rejected() {
        let config = Live2DAdapterConfig {
            profile_id: "fixture".into(),
            mouth: Some(MouthBinding { id: "../Param".into(), scale: 1.0, range: None }),
            blink: vec![], focus: vec![], emotion_params: HashMap::new(), overlay_settle: None,
            entrance_group: None, leave_group: None,
        };
        assert!(config.validate().is_err());
    }
}
