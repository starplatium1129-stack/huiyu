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

}

const GAZE_PARAMETERS: [&str; 4] = ["ParamAngleX", "ParamAngleY", "ParamEyeBallX", "ParamEyeBallY"];

#[derive(Default)]
pub struct ProfileParameters {
    pub mouth: Option<i32>,
    pub blink: Vec<i32>,
    pub gaze: [Option<i32>; GAZE_PARAMETERS.len()],
    pub overlays: Option<OverlayParameters>,
    emotions: HashMap<String, HashMap<i32, f32>>,
}

impl ProfileParameters {
    pub fn bind(model: &Model, profile: &Live2DAdapterConfig) -> Self {
        let resolve_values = |params: &HashMap<String, f32>| {
            params.iter().filter_map(|(id, value)| model.parameter_index(id).map(|index| (index, *value))).collect::<Vec<_>>()
        };
        Self {
            mouth: profile.mouth.as_ref().and_then(|mouth| model.parameter_index(&mouth.id)),
            blink: profile.blink.iter().filter_map(|id| model.parameter_index(id)).collect(),
            gaze: GAZE_PARAMETERS.map(|id| {
                profile.focus.iter().any(|candidate| candidate == id).then(|| model.parameter_index(id)).flatten()
            }),
            overlays: profile.overlay_settle.as_ref().map(|config| OverlayParameters {
                duration: config.settle_ms / 1000.0,
                defaults: resolve_values(&config.reset_defaults),
            }),
            emotions: profile.emotion_params.iter().map(|(name, params)| {
                (name.clone(), resolve_values(params).into_iter().collect())
            }).collect(),
        }
    }

    pub fn apply_emotion(&self, model: &mut Model, name: &str, intensity: f32) {
        let intensity = intensity.clamp(0.0, 1.0);
        let neutral = self.emotions.get("neutral");
        let target = self.emotions.get(name);
        // Sparse presets release only explicitly calibrated face parameters.
        for (&index, value) in neutral.into_iter().flatten() {
            let desired = target.and_then(|params| params.get(&index)).unwrap_or(value);
            model.set_parameter_by_index(index, value + (desired - value) * intensity, 1.0);
        }
        if intensity > 0.0 {
            for (&index, &value) in target.into_iter().flatten() {
                if !neutral.is_some_and(|params| params.contains_key(&index)) {
                    model.set_parameter_by_index(index, value, 1.0);
                }
            }
        }
    }
}

pub struct OverlayParameters {
    duration: f32,
    defaults: Vec<(i32, f32)>,
}

impl OverlayParameters {
    pub fn apply_defaults(&self, model: &mut Model) {
        for &(index, value) in &self.defaults {
            model.set_parameter_by_index(index, value, 1.0);
        }
    }
}

pub struct OverlaySettler {
    elapsed: f32,
    duration: f32,
    entries: Vec<(i32, f32, f32)>,
}

impl OverlaySettler {
    pub fn begin(model: &Model, overlays: &OverlayParameters) -> Option<Self> {
        let entries = overlays.defaults.iter().map(|&(index, target)| {
            (index, model.get_parameter_by_index(index), target)
        }).collect::<Vec<_>>();
        (!entries.is_empty()).then_some(Self {
            elapsed: 0.0,
            duration: overlays.duration,
            entries,
        })
    }

    pub fn step(&mut self, model: &mut Model, dt: f32) -> bool {
        self.elapsed = (self.elapsed + dt.max(0.0)).min(self.duration);
        let t = (self.elapsed / self.duration).clamp(0.0, 1.0);
        let eased = t * t * (3.0 - 2.0 * t);
        for &(index, from, target) in &self.entries {
            model.set_parameter_by_index(index, from + (target - from) * eased, 1.0);
        }
        t < 1.0
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
