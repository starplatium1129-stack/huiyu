use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

use image::RgbaImage;
use ring::digest::{Context, SHA256};

const MAGIC: &[u8; 8] = b"AICSRG01";
const MAX_DIMENSION: u32 = 8192;
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn fingerprint(source: &Path, scale: u32, root: Option<&Path>) -> Option<PathBuf> {
    let root = root?;
    let metadata = source.metadata().ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    let mut key = Context::new(&SHA256);
    key.update(source.as_os_str().as_encoded_bytes());
    key.update(&metadata.len().to_le_bytes());
    key.update(&modified.as_nanos().to_le_bytes());
    key.update(&scale.to_le_bytes());
    let digest: String = key.finish().as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
    Some(root.join(format!("{digest}.rgba")))
}

fn read(path: &Path) -> Option<RgbaImage> {
    let file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let mut file = BufReader::new(file);
    let mut header = [0; 16];
    file.read_exact(&mut header).ok()?;
    let width = u32::from_le_bytes(header[8..12].try_into().ok()?);
    let height = u32::from_le_bytes(header[12..16].try_into().ok()?);
    if &header[..8] != MAGIC || !(1..=MAX_DIMENSION).contains(&width) || !(1..=MAX_DIMENSION).contains(&height) {
        return None;
    }
    let size = u64::from(width) * u64::from(height) * 4;
    if length != size + header.len() as u64 { return None; }
    let mut data = vec![0; size as usize];
    file.read_exact(&mut data).ok()?;
    RgbaImage::from_raw(width, height, data)
}

fn write(path: &Path, image: &RgbaImage) {
    let Some(root) = path.parent() else { return; };
    if fs::create_dir_all(root).is_err() { return; }
    let serial = WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!("{}.{}.tmp", std::process::id(), serial));
    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(&temporary)?;
        file.write_all(MAGIC)?;
        file.write_all(&image.width().to_le_bytes())?;
        file.write_all(&image.height().to_le_bytes())?;
        file.write_all(image.as_raw())?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
}

fn decode(source: &Path, scale: u32, root: Option<&Path>) -> Result<RgbaImage, String> {
    let cached = fingerprint(source, scale, root);
    if let Some(image) = cached.as_deref().and_then(read) { return Ok(image); }
    let image = image::open(source).map_err(|error| format!("open texture {}: {error}", source.display()))?.into_rgba8();
    let (width, height) = super::frame_pacing::texture_dimensions(image.width(), image.height(), scale);
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!("Live2D texture exceeds the GPU limit: {}", source.display()));
    }
    let image = if scale > 1 {
        image::imageops::resize(&image, width, height, image::imageops::FilterType::Lanczos3)
    } else { image };
    // An asset can be replaced while its previous bytes are decoding.
    if let Some(path) = cached.filter(|path| fingerprint(source, scale, root).as_ref() == Some(path)) {
        write(&path, &image);
    }
    Ok(image)
}

/// Keep upload order and bound the number of decoded textures held at once.
pub(super) fn load(
    directory: &Path,
    textures: &[String],
    scale: u32,
    cache: Option<&Path>,
    mut consume: impl FnMut(RgbaImage),
) -> Result<(), String> {
    let workers = std::thread::available_parallelism().map_or(1, |parallelism| parallelism.get().min(4));
    for group in textures.chunks(workers) {
        std::thread::scope(|scope| {
            let jobs: Vec<_> = group.iter().map(|name| {
                scope.spawn(move || decode(&directory.join(name), scale, cache))
            }).collect();
            let mut outcome = Ok(());
            for job in jobs {
                match job.join().map_err(|_| "Live2D texture decoding stopped".to_owned()).and_then(|result| result) {
                    Ok(image) if outcome.is_ok() => consume(image),
                    Ok(_) => {}
                    Err(error) => outcome = Err(error),
                }
            }
            outcome
        })?;
    }
    Ok(())
}

pub(crate) fn warm_default(assets: &Path, cache: &Path) -> Result<(), String> {
    let model = super::live2d_assets::resolve_model(assets, None, "nene", "")?;
    let bytes = fs::read(model.manifest).map_err(|error| error.to_string())?;
    let manifest = super::model::parse_model3(&bytes)?;
    if let Some(files) = manifest.file_references {
        load(&model.directory, &files.textures, 1, Some(cache), drop)?;
    }
    Ok(())
}
