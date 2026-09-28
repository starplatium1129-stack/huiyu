//! Native renderer cache and long-run benchmark.
//!
//! This uses the same persistent target-texture path as the overlay renderer,
//! without readback. It is intentionally separate from the command-path
//! selftest so a single process can run for minutes and exercise model swaps.

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use live2d_native::model::{self, Model, ViewTransform};
use live2d_native::renderer::{self, Renderer, Texture};

struct Character {
    name: String,
    model: Model,
    textures: Vec<Texture>,
    transform: ViewTransform,
    motion_group: String,
    motion_count: usize,
    next_motion_index: usize,
}

struct Config {
    assets_root: PathBuf,
    seconds: u64,
    warmup_frames: usize,
    switch_every_seconds: u64,
    size: u32,
    target_fps: u32,
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

fn parse_args() -> Result<Config, String> {
    let mut config = Config {
        assets_root: PathBuf::from("assets/live2d"),
        seconds: 30,
        warmup_frames: 120,
        switch_every_seconds: 10,
        size: 800,
        target_fps: 165,
    };
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        let value = |index: &mut usize| -> Result<String, String> {
            *index += 1;
            args.get(*index)
                .cloned()
                .ok_or_else(|| "missing argument value".to_string())
        };
        match args[i].as_str() {
            "--assets-root" => config.assets_root = PathBuf::from(value(&mut i)?),
            "--seconds" => {
                config.seconds = value(&mut i)?.parse().map_err(|_| "invalid --seconds")?
            }
            "--warmup" => {
                config.warmup_frames = value(&mut i)?.parse().map_err(|_| "invalid --warmup")?
            }
            "--switch-every" => {
                config.switch_every_seconds = value(&mut i)?
                    .parse()
                    .map_err(|_| "invalid --switch-every")?
            }
            "--size" => config.size = value(&mut i)?.parse().map_err(|_| "invalid --size")?,
            "--fps" => config.target_fps = value(&mut i)?.parse().map_err(|_| "invalid --fps")?,
            other => return Err(format!("unknown argument: {other}")),
        }
        i += 1;
    }
    if config.seconds == 0 || config.size == 0 || config.target_fps == 0 {
        return Err("seconds, size and fps must be greater than zero".to_string());
    }
    Ok(config)
}

fn model_paths(dir: &Path) -> Result<(PathBuf, PathBuf), String> {
    let moc = std::fs::read_dir(dir)
        .map_err(|e| format!("read {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .find(|path| path.extension().map(|ext| ext == "moc3").unwrap_or(false))
        .ok_or_else(|| format!("no moc3 in {}", dir.display()))?;
    let model3 = dir.join("model3.json");
    let model3 = if model3.exists() {
        model3
    } else {
        let stem = moc
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("model");
        dir.join(format!("{stem}.model3.json"))
    };
    Ok((moc, model3))
}

fn load_character(
    renderer: &mut Renderer,
    assets_root: &Path,
    name: &str,
    size: u32,
) -> Result<Character, String> {
    let dir = assets_root.join(name);
    let (moc_path, model3_path) = model_paths(&dir)?;
    let moc = read(&moc_path)?;
    let model3_bytes = read(&model3_path)?;
    let manifest = model::parse_model3(&model3_bytes)?;
    let mut model = Model::create(&moc, &model3_bytes)?;
    let refs = manifest
        .file_references
        .as_ref()
        .ok_or_else(|| format!("{name}: model has no file references"))?;

    if let Some(physics) = &refs.physics {
        model.load_physics(&read(&dir.join(physics))?)?;
    }
    if let Some(pose) = &refs.pose {
        model.load_pose(&read(&dir.join(pose))?)?;
    }
    for expression in &refs.expressions {
        model.add_expression(&expression.name, &read(&dir.join(&expression.file))?)?;
    }
    for (group, motions) in &refs.motions {
        for (index, motion) in motions.iter().enumerate() {
            model.add_motion(group, index as i32, &read(&dir.join(&motion.file))?)?;
        }
    }

    let mut textures = Vec::with_capacity(refs.textures.len());
    for texture_path in &refs.textures {
        let image = image::open(dir.join(texture_path))
            .map_err(|e| format!("open {}/{}: {e}", name, texture_path))?
            .to_rgba8();
        let (width, height) = image.dimensions();
        textures.push(renderer.load_texture(&image.into_raw(), width, height));
    }
    renderer.release_texture_uploads();
    if textures.is_empty() {
        return Err(format!("{name}: no textures"));
    }

    let motion_group = if refs
        .motions
        .get("Idle")
        .is_some_and(|motions| !motions.is_empty())
    {
        "Idle".to_string()
    } else {
        refs.motions
            .iter()
            .find_map(|(group, motions)| (!motions.is_empty()).then(|| group.clone()))
            .ok_or_else(|| format!("{name}: no authored motions"))?
    };
    let motion_count = refs.motions.get(&motion_group).map(Vec::len).unwrap_or(0);
    model
        .start_motion(&motion_group, 0, model::PRIORITY_IDLE)
        .ok_or_else(|| format!("{name}: failed to start {motion_group}[0]"))?;
    let transform =
        ViewTransform::fit_content(model.content_bounds(), size as f32, size as f32, 0.02);
    Ok(Character {
        name: name.to_string(),
        model,
        textures,
        transform,
        motion_group,
        motion_count,
        next_motion_index: 1 % motion_count,
    })
}

fn percentile(samples: &[u64], percentile: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    let index = ((sorted.len() - 1) as f64 * percentile).round() as usize;
    sorted[index] as f64 / 1000.0
}

fn main() -> Result<(), String> {
    let config = parse_args()?;
    let (device, queue) = renderer::new_device()?;
    let mut renderer = Renderer::new(device, queue, wgpu::TextureFormat::Rgba8UnormSrgb);
    let target = renderer.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("live2d-soak-target"),
        size: wgpu::Extent3d {
            width: config.size,
            height: config.size,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: renderer.format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());

    let mut active = Some(load_character(
        &mut renderer,
        &config.assets_root,
        "nene",
        config.size,
    )?);
    let started = Instant::now();
    let frame_period = Duration::from_secs_f64(1.0 / config.target_fps as f64);
    let mut next_frame = started;
    let mut next_switch = if config.switch_every_seconds == 0 {
        None
    } else {
        Some(Duration::from_secs(config.switch_every_seconds))
    };
    let mut frame_times_us = Vec::new();
    let mut frames = 0usize;
    let mut model_switches = 0usize;
    let mut warmup_frame_creations = None;
    let mut all_switches_stable = true;
    let mut switch_stable_frames = 0usize;
    let mut model_load_time = Duration::ZERO;
    let mut last_progress = started;
    let mut last_update = started;
    let mut min_draw_calls = usize::MAX;
    let mut min_total_vertices = usize::MAX;
    let mut release_checks = 0usize;

    println!(
        "L2D_SOAK_START seconds={} target_fps={} size={} warmup={} switch_every={}",
        config.seconds,
        config.target_fps,
        config.size,
        config.warmup_frames,
        config.switch_every_seconds
    );

    while started.elapsed() < Duration::from_secs(config.seconds) {
        if let Some(switch_at) = next_switch {
            if started.elapsed() >= switch_at {
                let next_name = active
                    .as_ref()
                    .map(|character| {
                        if character.name == "nene" {
                            "natsume"
                        } else {
                            "nene"
                        }
                    })
                    .unwrap_or("nene");
                drop(active.take());
                renderer.release_model_resources();
                renderer
                    .device
                    .poll(wgpu::PollType::wait_indefinitely())
                    .expect("switch cleanup device poll failed");
                if !renderer.model_resources_released() {
                    return Err("renderer retained model resources after switch".to_string());
                }
                release_checks += 1;
                println!("L2D_SOAK_RELEASE count={release_checks}");
                let load_started = Instant::now();
                active = Some(load_character(
                    &mut renderer,
                    &config.assets_root,
                    next_name,
                    config.size,
                )?);
                model_load_time += load_started.elapsed();
                model_switches += 1;
                all_switches_stable = false;
                switch_stable_frames = 0;
                next_switch = Some(switch_at + Duration::from_secs(config.switch_every_seconds));
                renderer
                    .device
                    .poll(wgpu::PollType::wait_indefinitely())
                    .expect("switch device poll failed");
                println!(
                    "L2D_SOAK_SWITCH count={} character={next_name}",
                    model_switches
                );
            }
        }

        let frame_started = Instant::now();
        let character = active.as_mut().expect("active character");
        let update_now = Instant::now();
        let delta_time = update_now
            .duration_since(last_update)
            .as_secs_f32()
            .min(0.1);
        last_update = update_now;
        character.model.update(delta_time);
        if !character.model.has_playing_motion() {
            let motion_index = character.next_motion_index;
            character
                .model
                .start_motion(
                    &character.motion_group,
                    motion_index as i32,
                    model::PRIORITY_IDLE,
                )
                .ok_or_else(|| {
                    format!(
                        "{}: failed to restart {}[{motion_index}]",
                        character.name, character.motion_group
                    )
                })?;
            character.next_motion_index = (motion_index + 1) % character.motion_count;
        }
        character.transform = ViewTransform::fit_content(
            character.model.content_bounds(),
            config.size as f32,
            config.size as f32,
            0.02,
        );
        let encoder = renderer.draw_frame(
            &character.model,
            &character.transform,
            &character.textures,
            &target_view,
            config.size,
            config.size,
            false,
            None,
            true,
        );
        renderer.queue.submit(std::iter::once(encoder.finish()));
        renderer
            .device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("frame device poll failed");
        min_draw_calls = min_draw_calls.min(renderer.stats().draw_calls);
        min_total_vertices = min_total_vertices.min(renderer.stats().total_vertices);
        frame_times_us.push(frame_started.elapsed().as_micros() as u64);
        frames += 1;

        if !all_switches_stable && renderer.resource_stats().frame_creations == 0 {
            switch_stable_frames += 1;
            if switch_stable_frames >= 1 {
                all_switches_stable = true;
                println!("L2D_SOAK_SWITCH_STABLE frames={frames}");
            }
        }

        if frames == config.warmup_frames {
            warmup_frame_creations = Some(renderer.resource_stats().frame_creations);
            println!(
                "L2D_SOAK_WARMUP frame_creations={} total_creations={}",
                renderer.resource_stats().frame_creations,
                renderer.resource_stats().total_creations
            );
        }
        if last_progress.elapsed() >= Duration::from_secs(5) {
            let elapsed = started.elapsed().as_secs_f64();
            println!(
                "L2D_SOAK_PROGRESS frames={} elapsed_s={:.1} fps={:.1} p95_ms={:.3} frame_creations={} total_creations={}",
                frames,
                elapsed,
                frames as f64 / elapsed.max(0.001),
                percentile(&frame_times_us, 0.95),
                renderer.resource_stats().frame_creations,
                renderer.resource_stats().total_creations
            );
            last_progress = Instant::now();
        }

        next_frame += frame_period;
        if let Some(wait) = next_frame.checked_duration_since(Instant::now()) {
            thread::sleep(wait);
        } else {
            next_frame = Instant::now();
        }
    }

    let elapsed_s = started.elapsed().as_secs_f64();
    let render_elapsed_s = (elapsed_s - model_load_time.as_secs_f64()).max(0.001);
    drop(active.take());
    renderer.release_model_resources();
    renderer
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .expect("final cleanup device poll failed");
    if !renderer.model_resources_released() {
        return Err("renderer retained model resources after final destroy".to_string());
    }
    release_checks += 1;
    println!("L2D_SOAK_RELEASE_FINAL count={release_checks}");
    let resources = *renderer.resource_stats();
    let summary = serde_json::json!({
        "frames": frames,
        "elapsed_s": elapsed_s,
        "fps": frames as f64 / elapsed_s.max(0.001),
        "render_fps": frames as f64 / render_elapsed_s,
        "model_load_s": model_load_time.as_secs_f64(),
        "p50_ms": percentile(&frame_times_us, 0.50),
        "p95_ms": percentile(&frame_times_us, 0.95),
        "warmup_frame_creations": warmup_frame_creations,
        "final_frame_creations": renderer.resource_stats().frame_creations,
        "total_creations": renderer.resource_stats().total_creations,
        "model_switches": model_switches,
        "all_switches_stable": all_switches_stable,
        "target_fps": config.target_fps,
        "min_draw_calls": if frames == 0 { 0 } else { min_draw_calls },
        "min_total_vertices": if frames == 0 { 0 } else { min_total_vertices },
        "release_checks": release_checks,
        "resources_released": renderer.model_resources_released(),
        "backend": if cfg!(target_os = "windows") { "Dx12" } else { "Primary" },
        "resources": {
            "textures_created": resources.textures_created,
            "texture_upload_buffers_created": resources.texture_upload_buffers_created,
            "upload_buffers_created": resources.upload_buffers_created,
            "uniform_buffers_created": resources.uniform_buffers_created,
            "uniform_bind_groups_created": resources.uniform_bind_groups_created,
            "vertex_buffers_created": resources.vertex_buffers_created,
            "uv_buffers_created": resources.uv_buffers_created,
            "index_buffers_created": resources.index_buffers_created,
            "mask_textures_created": resources.mask_textures_created,
            "mask_bind_groups_created": resources.mask_bind_groups_created,
            "color_bind_groups_created": resources.color_bind_groups_created,
        },
    });
    println!("L2D_SOAK_SUMMARY {summary}");
    Ok(())
}
