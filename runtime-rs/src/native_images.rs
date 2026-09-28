//! Lazy native image operations. Production uses explicitly configured or bundled
//! native libraries; no Node process or npm lookup participates in decoding.
pub(crate) mod api;
pub(crate) mod library;
mod transform;

pub(crate) use transform::{atlas, thumbnail};

pub fn library_path(config: &crate::config::Config) -> std::path::PathBuf {
    std::env::var_os("AICS_VIPS_DYLIB_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            config.app_root.join("native").join(if cfg!(windows) {
                "libvips-42.dll"
            } else if cfg!(target_os = "macos") {
                "libvips.42.dylib"
            } else {
                "libvips.so.42"
            })
        })
}
