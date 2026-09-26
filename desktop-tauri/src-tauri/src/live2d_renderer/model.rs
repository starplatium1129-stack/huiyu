use super::*;

/// 按角色配置的"永不绘制" drawable 列表（产品修复，仅影响渲染，不影响
/// 命中区/动作）。夏目源模型自带三块可见的矩形底板/外框 drawable
/// （101/102/104，4 顶点），在透明桌宠窗口上呈现为用户投诉的"透明框"；
/// 宁宁模型没有这类 drawable，列表为空。
fn hidden_drawables_for(character: &str) -> Vec<i32> {
    match character {
        "natsume" => vec![101, 102, 104],
        _ => Vec::new(),
    }
}

impl RenderContext {
    pub(super) fn load_model(
        &mut self,
        assets_root: &std::path::Path,
        character: &str,
        texture_scale: u32,
        profile: Live2DAdapterConfig,
        local_root: Option<&std::path::Path>,
    ) -> Result<(), String> {
        if let Some(renderer) = self.renderer.as_mut() {
            renderer.release_model_resources();
        }
        self.model = None;
        self.fit_bounds = None;
        self.textures.clear();
        self.character = None;
        self.profile = None;
        self.overlay_settler = None;
        self.hit_area_names.clear();
        self.motion_counts.clear();
        self.motion_durations.clear();
        self.motion_last_indices.clear();
        self.active_motion = None;
        self.ready_emitted = false;
        let files = live2d_assets::resolve_model(assets_root, local_root, character, &profile.profile_id)?;
        let dir = files.directory;
        let moc_path = files.moc;
        let model3_path = files.manifest;
        let moc = std::fs::read(&moc_path).map_err(|e| e.to_string())?;
        let model3_bytes = std::fs::read(&model3_path).map_err(|e| e.to_string())?;
        let manifest = model::parse_model3(&model3_bytes)?;
        let motion_counts = manifest
            .file_references
            .as_ref()
            .map(|refs| {
                refs.motions
                    .iter()
                    .map(|(group, motions)| (group.clone(), motions.len()))
                    .collect()
            })
            .unwrap_or_default();
        let mut motion_durations: HashMap<String, Vec<f32>> = HashMap::new();

        let mut m = Model::create(&moc, &model3_bytes)?;
        m.set_hidden_drawables(&hidden_drawables_for(character));
        let mut textures: Vec<renderer::Texture> = Vec::new();
        if let Some(refs) = &manifest.file_references {
            if let Some(physics) = &refs.physics {
                let data = std::fs::read(dir.join(physics)).map_err(|e| e.to_string())?;
                m.load_physics(&data)?;
            }
            if let Some(pose) = &refs.pose {
                let data = std::fs::read(dir.join(pose)).map_err(|e| e.to_string())?;
                m.load_pose(&data)?;
            }
            for expr in &refs.expressions {
                let data = std::fs::read(dir.join(&expr.file)).map_err(|e| e.to_string())?;
                m.add_expression(&expr.name, &data)?;
            }
            for (group, motions) in &refs.motions {
                for (idx, mr) in motions.iter().enumerate() {
                    let data = std::fs::read(dir.join(&mr.file)).map_err(|e| e.to_string())?;
                    let duration = serde_json::from_slice::<serde_json::Value>(&data)
                        .ok()
                        .and_then(|value| value.get("Meta")?.get("Duration")?.as_f64())
                        .filter(|value| value.is_finite() && *value > 0.0)
                        .map(|value| value as f32)
                        .unwrap_or(5.0);
                    motion_durations
                        .entry(group.clone())
                        .or_default()
                        .push(duration);
                    m.add_motion(group, idx as i32, &data)?;
                }
            }
            let renderer = self.renderer.as_mut().ok_or("renderer not created")?;
            for (ti, tex) in refs.textures.iter().enumerate() {
                let path = dir.join(tex);
                let t0 = Instant::now();
                let img = image::open(&path)
                    .map_err(|e| format!("open texture {}: {e}", path.display()))?
                    .to_rgba8();
                let (w, h) = img.dimensions();
                let (w, h) = frame_pacing::texture_dimensions(w, h, texture_scale);
                let img = if texture_scale > 1 {
                    image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3)
                } else { img };
                textures.push(renderer.load_texture(&img.into_raw(), w, h));
                eprintln!(
                    "[live2d] texture {}/{} {w}x{h} {:.2}s",
                    ti + 1,
                    refs.textures.len(),
                    t0.elapsed().as_secs_f32()
                );
            }
            if textures.is_empty() {
                return Err("no textures".to_string());
            }
        }
        m.update(0.0);
        self.fit_bounds = Some(m.content_bounds());
        self.model = Some(m);
        self.textures = textures;
        self.character = Some(character.to_string());
        self.profile = Some(profile);
        self.hit_area_names = manifest.hit_areas.iter().map(|h| h.name.clone()).collect();
        self.motion_counts = motion_counts;
        self.motion_durations = motion_durations;
        Ok(())
    }

}
