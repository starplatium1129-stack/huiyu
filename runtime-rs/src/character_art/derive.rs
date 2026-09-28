use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ImageDecoder, ImageFormat, ImageReader};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::Cursor};
pub(super) struct Art {
    pub portrait: Vec<u8>,
    pub thumbnail: Vec<u8>,
    pub particles: Vec<u8>,
    pub revision: String,
    pub width: u32,
    pub height: u32,
    pub transparent: bool,
}
fn png(image: &image::DynamicImage) -> Result<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, ImageFormat::Png)
        .map_err(|_| invalid("无法编码图片"))?;
    Ok(out.into_inner())
}
pub(super) fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub(super) fn build(
    id: &str,
    data: &str,
    cancel: &CancellationToken,
    started: Instant,
) -> Result<Art> {
    let (head, encoded) = data
        .split_once(',')
        .ok_or_else(|| invalid("请上传 PNG、JPEG 或 WebP 图片"))?;
    let format = match head {
        "data:image/png;base64" => ImageFormat::Png,
        "data:image/jpeg;base64" => ImageFormat::Jpeg,
        "data:image/webp;base64" => ImageFormat::WebP,
        _ => return Err(invalid("请上传 PNG、JPEG 或 WebP 图片")),
    };
    if encoded.len() > 20 * 1024 * 1024 {
        return Err(invalid("图片超过 15 MiB"));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| invalid("图片编码无效"))?;
    if bytes.len() > 15 * 1024 * 1024 || image::guess_format(&bytes).ok() != Some(format) {
        return Err(invalid("图片格式或大小无效"));
    }
    let (width, height) = ImageReader::with_format(Cursor::new(&bytes), format)
        .into_dimensions()
        .map_err(|_| invalid("无法读取图片尺寸"))?;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 32_000_000
    {
        return Err(invalid("图片尺寸超过 8192 边长或 3200 万像素"));
    }
    check(cancel, started)?;
    let mut reader = ImageReader::with_format(Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(|_| invalid("图片解码失败"))?;
    let orientation = decoder
        .orientation()
        .map_err(|_| invalid("图片方向信息无效"))?;
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|_| invalid("图片解码失败"))?;
    image.apply_orientation(orientation);
    let (width, height) = (image.width(), image.height());
    let grid = image.thumbnail(128, 192).to_rgba8();
    if width < 5 || height < 5 || grid.width() < 5 || grid.height() < 5 {
        return Err(invalid("图片尺寸过小或宽高比过于极端，无法生成粒子头像"));
    }
    let transparent = image.to_rgba8().pixels().any(|p| p[3] < 255);
    check(cancel, started)?;
    let portrait = png(&image)?;
    let revision = hash(&portrait);
    let thumb = if width > 560 || height > 560 {
        image.resize(560, 560, image::imageops::FilterType::Lanczos3)
    } else {
        image.clone()
    };
    let thumbnail = png(&thumb)?;
    check(cancel, started)?;
    // Fixed 4-bit bins followed by nearest top-32 colors are deterministic,
    // bounded and retain transparent holes without guessing a background.
    let mut colors: HashMap<[u8; 3], usize> = HashMap::new();
    for p in grid.pixels().filter(|p| p[3] >= 32) {
        *colors
            .entry([p[0] & 0xf0, p[1] & 0xf0, p[2] & 0xf0])
            .or_default() += 1;
    }
    let mut ranked = colors.into_iter().collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let palette = ranked
        .into_iter()
        .take(32)
        .map(|(rgb, _)| rgb)
        .collect::<Vec<_>>();
    if palette.is_empty() {
        return Err(invalid("图片没有可生成粒子的可见内容"));
    }
    let cells = grid
        .pixels()
        .map(|p| {
            if p[3] < 32 {
                return '.';
            }
            let index = palette
                .iter()
                .enumerate()
                .min_by_key(|(_, rgb)| {
                    (0..3)
                        .map(|i| (i32::from(rgb[i]) - i32::from(p[i])).pow(2))
                        .sum::<i32>()
                })
                .unwrap()
                .0;
            char::from_digit(index as u32, 36).unwrap()
        })
        .collect::<String>();
    let particles = serde_json::to_vec(
        &json!({"id":id,"sourceSha256":revision,"aspect":width as f64/height as f64,"palette":palette.iter().map(|p|format!("#{:02x}{:02x}{:02x}",p[0],p[1],p[2])).collect::<Vec<_>>(),"grid":{"w":grid.width(),"h":grid.height(),"cells":cells}}),
    )?;
    check(cancel, started)?;
    Ok(Art {
        portrait,
        thumbnail,
        particles,
        revision,
        width,
        height,
        transparent,
    })
}
