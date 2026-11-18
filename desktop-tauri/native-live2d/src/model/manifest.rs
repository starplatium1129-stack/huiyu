use serde::Deserialize;

/// model3.json subset needed to enumerate assets and hit areas.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct Model3Json {
    #[serde(default)]
    pub version: Option<serde_json::Value>,
    #[serde(default)]
    pub file_references: Option<FileReferences>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub hit_areas: Vec<HitArea>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct FileReferences {
    #[serde(default)]
    pub moc: Option<String>,
    #[serde(default)]
    pub textures: Vec<String>,
    #[serde(default)]
    pub physics: Option<String>,
    #[serde(default)]
    pub pose: Option<String>,
    #[serde(default)]
    pub expressions: Vec<ExpressionRef>,
    #[serde(default)]
    pub motions: std::collections::HashMap<String, Vec<MotionRef>>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct ExpressionRef {
    pub name: String,
    pub file: String,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct MotionRef {
    pub file: String,
    #[serde(default)]
    pub fade_in_time: Option<f32>,
    #[serde(default)]
    pub fade_out_time: Option<f32>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct Group {
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct HitArea {
    pub name: String,
    pub id: String,
}

/// Load a model3.json from bytes.
pub fn parse_model3(json: &[u8]) -> Result<Model3Json, String> {
    serde_json::from_slice(json).map_err(|e| format!("model3.json parse failed: {e}"))
}
