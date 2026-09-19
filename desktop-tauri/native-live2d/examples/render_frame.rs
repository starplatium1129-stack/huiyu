//! PoC: load a Live2D model with the official native runtime, play a motion,
//! advance physics, render an offscreen frame with wgpu and save it as PNG.
//!
//! Usage:
//!   cargo run --release --example render_frame -- \
//!     --dir <model dir> [--motion-group Idle] [--motion-index 0] \
//!     [--frames 90] [--size 512] [--out frame.png]

use std::path::{Path, PathBuf};
use std::time::Instant;

use image::{Rgba, RgbaImage};
use live2d_native::model::{self, Model, ViewTransform};
use live2d_native::renderer::{self, Renderer};

fn read(path: &Path) -> std::io::Result<Vec<u8>> {
    std::fs::read(path)
}

fn find_moc_dir(dir: &Path) -> PathBuf {
    // Model dirs contain *.moc3; model3.json may live alongside.
    dir.to_path_buf()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut dir = PathBuf::from("../../assets/live2d/nene");
    let mut motion_group = "Idle".to_string();
    let mut motion_index = 0usize;
    let mut frames = 90usize;
    let mut size = 512u32;
    let mut out = PathBuf::from("frame.png");
    let mut manifest_name: Option<String> = None;
    let mut test_texture = false;
    let mut no_mask = false;
    let mut no_render = false;
    let mut no_motion = false;
    let mut only_drawable: Option<i32> = None;
    let mut hide: Vec<i32> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--manifest" => { i += 1; manifest_name = Some(args[i].clone()); }
            "--dir" => {
                i += 1;
                dir = PathBuf::from(&args[i]);
            }
            "--motion-group" => {
                i += 1;
                motion_group = args[i].clone();
            }
            "--motion-index" => {
                i += 1;
                motion_index = args[i].parse().unwrap();
            }
            "--frames" => {
                i += 1;
                frames = args[i].parse().unwrap();
            }
            "--size" => {
                i += 1;
                size = args[i].parse().unwrap();
            }
            "--out" => {
                i += 1;
                out = PathBuf::from(&args[i]);
            }
            "--flip-uv" => { /* V-flip is now always applied (matches wl-live2d) */ }
            "--test-texture" => {
                test_texture = true;
            }
            "--no-mask" => {
                no_mask = true;
            }
            "--no-render" => {
                no_render = true;
            }
            "--no-motion" => {
                no_motion = true;
            }
            "--drawable" => {
                i += 1;
                only_drawable = Some(args[i].parse().unwrap());
            }
            "--hide" => {
                i += 1;
                hide = args[i]
                    .split(',')
                    .filter_map(|s| s.trim().parse::<i32>().ok())
                    .collect();
            }
            other => {
                eprintln!("unknown arg: {other}");
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let dir = find_moc_dir(&dir);
    let moc_path = std::fs::read_dir(&dir)
        .expect("model dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().map(|e| e == "moc3").unwrap_or(false))
        .expect("no .moc3 in model dir");
    let model3_path = dir.join(manifest_name.unwrap_or_else(|| "model3.json".into()));
    let model3_path = if model3_path.exists() {
        model3_path
    } else {
        // nene.model3.json style naming
        dir.join(moc_path.file_stem().unwrap())
            .with_extension("model3.json")
    };

    println!("moc:   {}", moc_path.display());
    println!("model3: {}", model3_path.display());

    let moc = read(&moc_path).expect("read moc3");
    let model3_bytes = read(&model3_path).expect("read model3.json");
    let manifest = model::parse_model3(&model3_bytes).expect("parse model3");
    eprintln!("[manifest] {:#?}", manifest);

    let mut model = Model::create(&moc, &model3_bytes).expect("create model");
    if !hide.is_empty() {
        model.set_hidden_drawables(&hide);
        eprintln!("[diag] hidden drawables: {hide:?}");
    }
    let canvas_w = model.canvas_width();
    let canvas_h = model.canvas_height();
    println!(
        "canvas: {canvas_w} x {canvas_h}, drawables: {}",
        model.drawable_count()
    );

    // Load all motions / expressions / physics / pose from the manifest.
    if no_render {
        eprintln!("[test] created model, skipping asset loading, dropping...");
        return;
    }
    if let Some(refs) = &manifest.file_references {
        let base = dir.as_path();
        if let Some(physics) = &refs.physics {
            let data = read(&base.join(physics)).expect("physics file");
            model.load_physics(&data).expect("load physics");
            println!("physics: {physics}");
        }
        if let Some(pose) = &refs.pose {
            let data = read(&base.join(pose)).expect("pose file");
            model.load_pose(&data).expect("load pose");
            println!("pose: {pose}");
        }
        for expr in &refs.expressions {
            let data = read(&base.join(&expr.file)).expect("expression file");
            model
                .add_expression(&expr.name, &data)
                .expect("add expression");
            println!("expression: {} ({})", expr.name, expr.file);
        }
        let mut groups: Vec<(String, usize)> = Vec::new();
        for (group, motions) in &refs.motions {
            for (idx, m) in motions.iter().enumerate() {
                let data = read(&base.join(&m.file)).expect("motion file");
                model
                    .add_motion(group, idx as i32, &data)
                    .expect("add motion");
            }
            println!("motion group {group}: {} motions", motions.len());
            groups.push((group.clone(), motions.len()));
        }
        let _ = groups;

        // Textures.
        let (device, queue) = renderer::new_device().expect("wgpu device");
        let mut renderer = Renderer::new(device, queue, wgpu::TextureFormat::Rgba8UnormSrgb);
        let mut textures = Vec::new();
        if test_texture {
            // 2x2 quadrant: TL red, TR green, BL blue, BR yellow
            let mut rgba = Vec::with_capacity(64 * 64 * 4);
            for y in 0..64u32 {
                for x in 0..64u32 {
                    let (r, g, b) = if x < 32 && y < 32 {
                        (255, 0, 0)
                    } else if x >= 32 && y < 32 {
                        (0, 255, 0)
                    } else if x < 32 && y >= 32 {
                        (0, 0, 255)
                    } else {
                        (255, 255, 0)
                    };
                    rgba.extend_from_slice(&[r, g, b, 255]);
                }
            }
            textures.push(renderer.load_texture(&rgba, 64, 64));
            eprintln!("[geom] using 2x2 quadrant test texture");
            // Some models reference more texture slots (multi-texture exports).
            while textures.len() < 16 {
                textures.push(renderer.load_texture(&rgba, 64, 64));
            }
        } else {
            for tex in &refs.textures {
                let path = base.join(tex);
                println!("texture: {tex}");
                let img = image::open(&path).expect("open texture").to_rgba8();
                let (w, h) = img.dimensions();
                let rgba = img.into_raw();
                textures.push(renderer.load_texture(&rgba, w, h));
            }
        }
        if textures.is_empty() {
            eprintln!("no textures found");
            std::process::exit(2);
        }

        // Play the requested motion. (--no-motion skips it)
        let motion_handle = if no_motion {
            None
        } else {
            model.start_motion(&motion_group, motion_index as i32, model::PRIORITY_NORMAL)
        };
        match motion_handle {
            Some(handle) => {
                println!("motion started: {motion_group}[{motion_index}] handle={handle:?}")
            }
            None if no_motion => println!("motion skipped (--no-motion)"),
            None => {
                eprintln!("motion group {motion_group} index {motion_index} not found");
                std::process::exit(2);
            }
        }

        let bounds = model.content_bounds();
        eprintln!(
            "[geom] content_bounds min=[{:.3},{:.3}] max=[{:.3},{:.3}]",
            bounds.0[0], bounds.0[1], bounds.1[0], bounds.1[1]
        );
        let mut transform = ViewTransform::fit_content(bounds, size as f32, size as f32, 0.02);
        if let Ok(s) = std::env::var("L2D_SCALE") {
            transform.scale = s.parse().unwrap_or(transform.scale);
            eprintln!("[geom] scale override: {}", transform.scale);
        }
        {
            let ds = model.drawables();
            for (name, id) in [
                ("Face", "ArtMesh178"),
                ("Head", "ArtMesh175"),
                ("Hair", "ArtMesh73"),
                ("Skirt", "ArtMesh330"),
                ("Body", "ArtMesh332"),
            ] {
                if let Some(idx) = model.drawable_index(id) {
                    let d = &ds[idx as usize];
                    let (mut lx, mut hx, mut ly, mut hy) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                    for p in &d.positions {
                        lx = lx.min(p[0]);
                        hx = hx.max(p[0]);
                        ly = ly.min(p[1]);
                        hy = hy.max(p[1]);
                    }
                    eprintln!(
                        "[geom] {name}({id}) bbox x[{lx:.3},{hx:.3}] y[{ly:.3},{hy:.3}] visible={}",
                        d.visible
                    );
                } else {
                    eprintln!("[geom] {name}({id}) NOT FOUND");
                }
            }
        }
        {
            let ds = model.drawables();
            let mut min_x = f32::MAX;
            let mut max_x = f32::MIN;
            let mut min_y = f32::MAX;
            let mut max_y = f32::MIN;
            for d in ds.iter().take(200) {
                for p in &d.positions {
                    min_x = min_x.min(p[0]);
                    max_x = max_x.max(p[0]);
                    min_y = min_y.min(p[1]);
                    max_y = max_y.max(p[1]);
                }
            }
            eprintln!(
                "[geom] positions x[{min_x:.2},{max_x:.2}] y[{min_y:.2},{max_y:.2}] canvas {canvas_w}x{canvas_h}"
            );
            let mut uv_min_x = f32::MAX;
            let mut uv_max_x = f32::MIN;
            let mut uv_min_y = f32::MAX;
            let mut uv_max_y = f32::MIN;
            let mut mults = std::collections::BTreeMap::new();
            let mut masked = 0usize;
            let mut not_visible = 0usize;
            let mut blend_modes = std::collections::BTreeMap::new();
            for d in ds.iter() {
                for uv in &d.uvs {
                    uv_min_x = uv_min_x.min(uv[0]);
                    uv_max_x = uv_max_x.max(uv[0]);
                    uv_min_y = uv_min_y.min(uv[1]);
                    uv_max_y = uv_max_y.max(uv[1]);
                }
                let key = format!(
                    "{:.2}x{:.2}x{:.2}x{:.2}",
                    d.multiply_color[0],
                    d.multiply_color[1],
                    d.multiply_color[2],
                    d.multiply_color[3]
                );
                *mults.entry(key).or_insert(0usize) += 1;
                *blend_modes.entry(d.color_blend).or_insert(0usize) += 1;
                if !d.masks.is_empty() {
                    masked += 1;
                }
                if !d.visible {
                    not_visible += 1;
                }
            }
            eprintln!("[geom] uv x[{uv_min_x:.3},{uv_max_x:.3}] y[{uv_min_y:.3},{uv_max_y:.3}]");
            eprintln!("[geom] multiply colors: {:?}", mults);
            eprintln!("[geom] blend modes: {:?}", blend_modes);
            eprintln!(
                "[geom] masked={masked} hidden={not_visible} total={}",
                ds.len()
            );
            for d in ds.iter().take(3) {
                eprintln!(
                    "[geom] drawable {} verts={} first pos {:?} uv {:?}",
                    d.index,
                    d.vertex_count,
                    d.positions.first(),
                    d.uvs.first()
                );
            }
        }
        if no_render {
            eprintln!("[test] created model, skipping render, dropping...");
            return;
        }
        let dt = 1.0 / 60.0;
        let started = Instant::now();
        let mut last = started;
        for frame in 0..frames {
            let now = Instant::now();
            let elapsed = now.duration_since(last).as_secs_f32().min(0.1);
            last = now;
            model.update(elapsed.max(dt));

            let pixels = renderer.render_to_image(
                &model,
                &transform,
                &textures,
                size,
                size,
                no_mask,
                only_drawable,
            );
            if frame == 0 {
                let rb = model.content_bounds();
                eprintln!(
                    "[geom] render-time content_bounds min=[{:.3},{:.3}] max=[{:.3},{:.3}]",
                    rb.0[0], rb.0[1], rb.1[0], rb.1[1]
                );
                let ds0 = model.drawables();
                let mut screens = std::collections::BTreeMap::new();
                for d in ds0.iter() {
                    let key = format!(
                        "{:.2}x{:.2}x{:.2}x{:.2}",
                        d.screen_color[0], d.screen_color[1], d.screen_color[2], d.screen_color[3]
                    );
                    *screens.entry(key).or_insert(0usize) += 1;
                }
                eprintln!("[geom] screen colors: {screens:?}");
                for aid in [
                    "ArtMesh133",
                    "ArtMesh335",
                    "ArtMesh134",
                    "ArtMesh5",
                    "ArtMesh71",
                ] {
                    if let Some(idx) = model.drawable_index(aid) {
                        let d = &ds0[idx as usize];
                        eprintln!(
                            "[cmp] {aid} idx={idx} vc={} ic={} masks={:?} visible={} opacity={:.3} first6={:?} first6idx={:?}",
                            d.vertex_count,
                            d.indices.len(),
                            d.masks,
                            d.visible,
                            d.opacity,
                            &d.positions[..6.min(d.positions.len())],
                            &d.indices[..6.min(d.indices.len())]
                        );
                    }
                }
                let mut wide: Vec<(usize, f32, f32, usize)> = Vec::new();
                for (i, d) in ds0.iter().enumerate() {
                    if !d.visible {
                        continue;
                    }
                    let (mut lx, mut hx) = (f32::MAX, f32::MIN);
                    for p in &d.positions {
                        lx = lx.min(p[0]);
                        hx = hx.max(p[0]);
                    }
                    if hx > 0.35 || lx < -0.35 {
                        wide.push((i, lx, hx, d.vertex_count));
                    }
                }
                eprintln!("[geom] visible drawables with |x|>0.35: {wide:?}");
                if let Some(d335) = ds0.get(335) {
                    eprintln!(
                        "[mask] d335 masks={:?} verts={}",
                        d335.masks, d335.vertex_count
                    );
                    if let Some(src) = d335.masks.first().and_then(|&m| ds0.get(m as usize)) {
                        let (mut lx, mut hx, mut ly, mut hy) =
                            (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                        for p in &src.positions {
                            lx = lx.min(p[0]);
                            hx = hx.max(p[0]);
                            ly = ly.min(p[1]);
                            hy = hy.max(p[1]);
                        }
                        eprintln!(
                            "[mask] d335 mask-source idx={} verts={} visible={} opacity={:.3} bbox x[{lx:.3},{hx:.3}] y[{ly:.3},{hy:.3}]",
                            src.index, src.vertex_count, src.visible, src.opacity
                        );
                    }
                    if !d335.masks.is_empty() {
                        if let Some(mask_px) = renderer.dump_mask_channel(
                            &model,
                            &transform,
                            &textures,
                            size,
                            size,
                            &d335.masks,
                        ) {
                            let mut buckets = [0usize; 4];
                            let mut nonzero = 0usize;
                            for m in mask_px.chunks_exact(4) {
                                if m[3] > 8 {
                                    nonzero += 1;
                                    buckets[((m[3] as usize) / 64).min(3)] += 1;
                                }
                            }
                            eprintln!(
                                "[mask] d335 channel nonzero={nonzero} buckets=[{},{},{},{}]",
                                buckets[0], buckets[1], buckets[2], buckets[3]
                            );
                        }
                    }
                }
                eprintln!(
                    "[geom] render-time content_bounds min=[{:.3},{:.3}] max=[{:.3},{:.3}]",
                    rb.0[0], rb.0[1], rb.1[0], rb.1[1]
                );
                let ds0 = model.drawables();
                if ds0.len() > 32 {
                    let d = &ds0[32];
                    let mut max_abs = 0f32;
                    let mut nan_count = 0usize;
                    for p in &d.positions {
                        if p[0].is_nan()
                            || p[1].is_nan()
                            || p[0].is_infinite()
                            || p[1].is_infinite()
                        {
                            nan_count += 1;
                        }
                        max_abs = max_abs.max(p[0].abs()).max(p[1].abs());
                    }
                    eprintln!("[geom] d32 max_abs_vertex={max_abs:.3} nan/inf={nan_count}");
                    eprintln!(
                        "[geom] d32 first 30 indices: {:?}",
                        &d.indices[..30.min(d.indices.len())]
                    );
                }
                let face_mask_set = model
                    .drawable_index("ArtMesh178")
                    .and_then(|fi| ds0.get(fi as usize))
                    .and_then(|d| (!d.masks.is_empty()).then(|| d.masks.clone()));
                if let Some(set) = &face_mask_set {
                    eprintln!("[mask] Face(63) masks={set:?}");
                    if let Some(mask_px) =
                        renderer.dump_mask_channel(&model, &transform, &textures, size, size, set)
                    {
                        let opaque = mask_px.chunks_exact(4).filter(|p| p[3] > 8).count();
                        eprintln!(
                            "[mask] face channel opaque={opaque}/{}",
                            size as usize * size as usize
                        );
                        let mask_img =
                            RgbaImage::from_raw(size, size, mask_px).expect("mask image");
                        let bg = Rgba([20, 20, 60, 255]);
                        let mut canvas = RgbaImage::from_pixel(size, size, bg);
                        for (x, y, p) in mask_img.enumerate_pixels() {
                            if p.0[3] > 8 {
                                canvas.put_pixel(x, y, Rgba([255, 255, 255, 255]));
                            }
                        }
                        let mut mask_out = out.clone();
                        mask_out.set_file_name(format!(
                            "mask_face_{}",
                            out.file_name().unwrap().to_string_lossy()
                        ));
                        canvas.save(&mask_out).expect("save mask png");
                        eprintln!("[mask] saved {}", mask_out.display());
                    }
                }
                let first_mask = ds0.iter().find(|d| !d.masks.is_empty());
                if let Some(fm) = first_mask {
                    let idx5 = model.drawable_index("ArtMesh178").unwrap_or(-1);
                    eprintln!(
                        "[mask] first masked drawable idx={} masks={:?} (Face drawable idx={idx5})",
                        fm.index, fm.masks
                    );
                    for mi in &fm.masks {
                        let d = &ds0[*mi as usize];
                        let (mut lx, mut hx, mut ly, mut hy) =
                            (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                        for p in &d.positions {
                            lx = lx.min(p[0]);
                            hx = hx.max(p[0]);
                            ly = ly.min(p[1]);
                            hy = hy.max(p[1]);
                        }
                        eprintln!(
                            "[mask] source idx={} verts={} visible={} opacity={:.3} tex={} bbox x[{lx:.3},{hx:.3}] y[{ly:.3},{hy:.3}]",
                            d.index, d.vertex_count, d.visible, d.opacity, d.texture_index
                        );
                    }
                    {
                        let d = &ds0[fm.index as usize];
                        let (mut lx, mut hx, mut ly, mut hy) =
                            (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                        for p in &d.positions {
                            lx = lx.min(p[0]);
                            hx = hx.max(p[0]);
                            ly = ly.min(p[1]);
                            hy = hy.max(p[1]);
                        }
                        eprintln!(
                            "[mask] clipped idx={} bbox x[{lx:.3},{hx:.3}] y[{ly:.3},{hy:.3}]",
                            d.index
                        );
                    }
                }
                for i in 55..90usize {
                    if i >= ds0.len() {
                        break;
                    }
                    let d = &ds0[i];
                    if !d.masks.is_empty() {
                        eprintln!(
                            "[mask] drawable {i} masks={:?} visible={}",
                            d.masks, d.visible
                        );
                    }
                }
                let mut masked_visible: Vec<(usize, f32, f32)> = Vec::new();
                for (i, d) in ds0.iter().enumerate() {
                    if d.visible && !d.masks.is_empty() {
                        let (mut ly, mut hy) = (f32::MAX, f32::MIN);
                        for p in &d.positions {
                            ly = ly.min(p[1]);
                            hy = hy.max(p[1]);
                        }
                        masked_visible.push((i, ly, hy));
                    }
                }
                for (i, ly, hy) in &masked_visible {
                    let sy0 = 256.0 - hy * 256.0;
                    let sy1 = 256.0 - ly * 256.0;
                    eprintln!(
                        "[mask] visible-masked idx={i} masks={:?} screen y[{sy0:.0},{sy1:.0}]",
                        ds0[*i].masks
                    );
                }
                for mi in [115usize, 99, 74, 65, 67] {
                    if mi < ds0.len() {
                        let d = &ds0[mi];
                        let (mut lx, mut hx, mut ly, mut hy) =
                            (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                        let (mut ulx, mut uhx, mut uly, mut uhy) =
                            (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                        for p in &d.positions {
                            lx = lx.min(p[0]);
                            hx = hx.max(p[0]);
                            ly = ly.min(p[1]);
                            hy = hy.max(p[1]);
                        }
                        for uv in &d.uvs {
                            ulx = ulx.min(uv[0]);
                            uhx = uhx.max(uv[0]);
                            uly = uly.min(uv[1]);
                            uhy = uhy.max(uv[1]);
                        }
                        eprintln!(
                            "[mask] src{mi} verts={} visible={} opacity={:.3} tex={} bbox x[{lx:.3},{hx:.3}] y[{ly:.3},{hy:.3}] uv x[{ulx:.3},{uhx:.3}] y[{uly:.3},{uhy:.3}]",
                            d.vertex_count, d.visible, d.opacity, d.texture_index
                        );
                    }
                }
                for ci in [62usize, 64, 66, 69, 73, 81, 82] {
                    if ci >= ds0.len() {
                        continue;
                    }
                    let d = &ds0[ci];
                    let (mut lx, mut hx, mut ly, mut hy) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                    for p in &d.positions {
                        lx = lx.min(p[0]);
                        hx = hx.max(p[0]);
                        ly = ly.min(p[1]);
                        hy = hy.max(p[1]);
                    }
                    eprintln!(
                        "[mask] clipped{ci} masks={:?} visible={} bbox x[{lx:.3},{hx:.3}] y[{ly:.3},{hy:.3}]",
                        d.masks, d.visible
                    );
                }
                if let Some(mask_px) =
                    renderer.dump_mask_channel(&model, &transform, &textures, size, size, &[115])
                {
                    let mut buckets = [0usize; 4];
                    let mut nonzero = 0usize;
                    for m in mask_px.chunks_exact(4) {
                        if m[3] > 8 {
                            nonzero += 1;
                            buckets[((m[3] as usize) / 64).min(3)] += 1;
                        }
                    }
                    eprintln!(
                        "[maskalpha] channel[115] nonzero={nonzero} buckets(0-63/64-127/128-191/192-255)=[{},{},{},{}]",
                        buckets[0], buckets[1], buckets[2], buckets[3]
                    );
                }
                let ds = model.drawables();
                let visible = ds.iter().filter(|d| d.visible).count();
                let masked = ds.iter().filter(|d| !d.masks.is_empty()).count();
                eprintln!(
                    "[geom] after update: visible={visible}/{} masked={masked}",
                    ds.len()
                );
                let hidden: Vec<_> = ds.iter().filter(|d| !d.visible).collect();
                let hidden_opacity = hidden.iter().filter(|d| d.opacity > 0.01).count();
                eprintln!(
                    "[geom] hidden={} of which opacity>0: {hidden_opacity}",
                    hidden.len()
                );
                let mut rows: Vec<(i32, f32, f32, f32)> = ds
                    .iter()
                    .filter(|d| d.visible)
                    .map(|d| {
                        let (mut lx, mut hx, mut ly, mut hy) =
                            (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                        for p in &d.positions {
                            lx = lx.min(p[0]);
                            hx = hx.max(p[0]);
                            ly = ly.min(p[1]);
                            hy = hy.max(p[1]);
                        }
                        (d.index, (hx - lx) * (hy - ly), (hx - lx), (hy - ly))
                    })
                    .collect();
                rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
                for (idx, area, w, h) in rows.iter().take(6) {
                    eprintln!("[geom] top drawable idx={idx} area={area:.4} w={w:.3} h={h:.3}");
                }
                let d0 = &ds[0];
                eprintln!(
                    "[geom] d0 uv first={:?} last={:?}",
                    d0.uvs.first(),
                    d0.uvs.last()
                );
                for idx in [120usize, 335, 334, 197] {
                    if idx < ds.len() {
                        let d = &ds[idx];
                        let (min_i, max_i) = d
                            .indices
                            .iter()
                            .fold((u16::MAX, 0u16), |(mn, mx), &v| (mn.min(v), mx.max(v)));
                        eprintln!(
                        "[geom] d{idx} verts={} indices={} idx_range=[{min_i},{max_i}] valid={}",
                        d.vertex_count,
                        d.indices.len(),
                        (max_i as usize) < d.vertex_count
                    );
                    }
                }
            }
            if frame == frames - 1 {
                let ds_last = model.drawables();
                for name in [
                    "ParamAngleX",
                    "ParamAngleY",
                    "ParamAngleZ",
                    "ParamBodyAngleX",
                    "ParamEyeLOpen",
                    "ParamEyeROpen",
                    "ParamMouthOpenY",
                    "ParamCheek",
                ] {
                    eprintln!("[param] {name} = {:.4}", model.get_parameter(name));
                }
                for aid in [
                    "ArtMesh134",
                    "ArtMesh136",
                    "ArtMesh135",
                    "ArtMesh133",
                    "ArtMesh5",
                ] {
                    if let Some(idx) = model.drawable_index(aid) {
                        let d = &ds_last[idx as usize];
                        eprintln!(
                            "[param] {aid} idx={idx} visible={} opacity={:.3} masks={:?}",
                            d.visible, d.opacity, d.masks
                        );
                    }
                }
                for ci in [5usize, 196] {
                    if ci >= ds_last.len() {
                        continue;
                    }
                    let d = &ds_last[ci];
                    let (mut lx, mut hx, mut ly, mut hy) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
                    for p in &d.positions {
                        lx = lx.min(p[0]);
                        hx = hx.max(p[0]);
                        ly = ly.min(p[1]);
                        hy = hy.max(p[1]);
                    }
                    let sx0 = 256.0 + lx * 256.0;
                    let sx1 = 256.0 + hx * 256.0;
                    let sy0 = 256.0 - hy * 256.0;
                    let sy1 = 256.0 - ly * 256.0;
                    eprintln!(
                        "[frame] last-frame d{ci} bbox canvas x[{lx:.3},{hx:.3}] y[{ly:.3},{hy:.3}] -> screen x[{sx0:.0},{sx1:.0}] y[{sy0:.0},{sy1:.0}]"
                    );
                }
                let opaque: usize = pixels.chunks_exact(4).filter(|px| px[3] > 8).count();
                let mut sum = [0u64; 3];
                let mut n = 0usize;
                for px in pixels.chunks_exact(4) {
                    if px[3] > 8 {
                        sum[0] += px[0] as u64;
                        sum[1] += px[1] as u64;
                        sum[2] += px[2] as u64;
                        n += 1;
                    }
                }
                if n > 0 {
                    eprintln!(
                        "[pix] opaque={opaque}/{} avg_rgb=({},{},{})",
                        size as usize * size as usize,
                        sum[0] / n as u64,
                        sum[1] / n as u64,
                        sum[2] / n as u64
                    );
                }
                // Overlay the first mask channel in red when L2D_OVERLAY_MASK=1
                // (verifies mask shape alignment against the main frame).
                let mut frame_px = pixels.clone();
                if std::env::var("L2D_OVERLAY_MASK").is_ok() {
                    if let Some(mask_px) = renderer.dump_mask_channel(
                        &model,
                        &transform,
                        &textures,
                        size,
                        size,
                        if std::env::var("L2D_OVERLAY_MASK2").is_ok() {
                            &[196]
                        } else {
                            &[115]
                        },
                    ) {
                        for (i, m) in mask_px.chunks_exact(4).enumerate() {
                            if m[3] > 8 {
                                let o = i * 4;
                                frame_px[o] = 255;
                                frame_px[o + 1] = frame_px[o + 1].min(60);
                                frame_px[o + 2] = frame_px[o + 2].min(60);
                            }
                        }
                    }
                }
                let img = RgbaImage::from_raw(size, size, frame_px).expect("rgba image");
                if std::env::var("L2D_TRANSPARENT_OUT").is_ok() {
                    // Raw renderer output (premultiplied RGBA) straight to PNG.
                    img.save(&out).expect("save png");
                } else {
                    let bg = Rgba([36, 24, 58, 255]);
                    let mut canvas = RgbaImage::from_pixel(size, size, bg);
                    for (x, y, p) in img.enumerate_pixels() {
                        let a = p.0[3] as f32 / 255.0;
                        if a > 0.0 {
                            // Composite straight (unpremultiplied) source over bg.
                            let px = canvas.get_pixel_mut(x, y);
                            px.0[0] = (p.0[0] as f32 * a + px.0[0] as f32 * (1.0 - a)) as u8;
                            px.0[1] = (p.0[1] as f32 * a + px.0[1] as f32 * (1.0 - a)) as u8;
                            px.0[2] = (p.0[2] as f32 * a + px.0[2] as f32 * (1.0 - a)) as u8;
                            px.0[3] = 255;
                        }
                    }
                    canvas.save(&out).expect("save png");
                }
                println!(
                    "saved {} at frame {frame} ({:.2}s sim), draw calls: {}, mask textures: {}, vertices: {}",
                    out.display(),
                    frame as f32 * dt,
                    renderer.stats().draw_calls,
                    renderer.stats().mask_textures,
                    renderer.stats().total_vertices,
                );
                // TEMP DIAG (2026-08-16 发灰排查): 主动作播完后
                // - L2D_RESET_ALL=1: 全部参数重置为 moc3 默认值再渲染
                // - L2D_AFTER_IDLE=1: 接 Idle_0 90 帧再渲染
                let reset_all = std::env::var("L2D_RESET_ALL").is_ok();
                let after_idle = std::env::var("L2D_AFTER_IDLE").is_ok();
                if reset_all || after_idle {
                    if reset_all {
                        model.reset_all_parameters();
                        model.update(1.0 / 60.0); // 刷新 drawable 快照
                        eprintln!("[diag] all params reset to defaults + update");
                    } else {
                        let _ = model.start_motion("Idle", 0, model::PRIORITY_NORMAL);
                        for _ in 0..90 {
                            model.update(1.0 / 60.0);
                        }
                    }
                    let pixels2 = renderer.render_to_image(
                        &model, &transform, &textures, size, size, no_mask, only_drawable,
                    );
                    let tag = if reset_all { "reset-all" } else { "after-idle" };
                    let mut out2 = out.clone();
                    out2.set_file_name(format!(
                        "{tag}_{}",
                        out.file_name().unwrap().to_string_lossy()
                    ));
                    if std::env::var("L2D_TRANSPARENT_OUT").is_ok() {
                        RgbaImage::from_raw(size, size, pixels2)
                            .expect("rgba image2")
                            .save(&out2)
                            .expect("save png2");
                    } else {
                        let bg = Rgba([36, 24, 58, 255]);
                        let mut canvas = RgbaImage::from_pixel(size, size, bg);
                        for (x, y, p) in
                            RgbaImage::from_raw(size, size, pixels2)
                                .expect("rgba image2")
                                .enumerate_pixels()
                        {
                            let a = p.0[3] as f32 / 255.0;
                            if a > 0.0 {
                                let px = canvas.get_pixel_mut(x, y);
                                px.0[0] = (p.0[0] as f32 * a + px.0[0] as f32 * (1.0 - a)) as u8;
                                px.0[1] = (p.0[1] as f32 * a + px.0[1] as f32 * (1.0 - a)) as u8;
                                px.0[2] = (p.0[2] as f32 * a + px.0[2] as f32 * (1.0 - a)) as u8;
                                px.0[3] = 255;
                            }
                        }
                        canvas.save(&out2).expect("save png2");
                    }
                    eprintln!("[diag] {tag} saved {}", out2.display());
                }
            }
        }
        println!("total wall time: {:.2}s", started.elapsed().as_secs_f32());
    } else {
        eprintln!("no file_references in model3.json");
        std::process::exit(2);
    }
}
