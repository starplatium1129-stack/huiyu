mod error {
    pub use huiyu_runtime::error::*;
}
#[path = "../src/native_images/library.rs"]
mod library;
use library as native_library;
#[path = "../src/interrogate/fixture_model.rs"]
mod fixture_model;
#[path = "../src/interrogate/model.rs"]
mod model;
#[path = "../src/interrogate/ort_runtime.rs"]
#[allow(
    dead_code,
    reason = "The isolated native ABI fixture exercises inference; production worker cancellation is covered by the service test"
)]
mod ort_runtime;
#[path = "../src/interrogate/preprocess.rs"]
mod preprocess;
#[path = "../src/native_images/api.rs"]
#[allow(
    dead_code,
    reason = "This isolated WD14 fixture imports the private FFI table but does not use atlas and thumbnail functions"
)]
mod vips_api;

#[test]
#[ignore = "Requires explicitly selected native DLLs and neutral pixels; never reads production weights"]
fn synthetic_onnx_cpu_tensor_and_labels() {
    let root = tempfile::tempdir().unwrap();
    fixture_model::write(root.path());
    let selected_library =
        std::path::PathBuf::from(std::env::var_os("AICS_TEST_ORT_DLL").expect("explicit ORT DLL"));
    let selected_vips = std::path::PathBuf::from(
        std::env::var_os("AICS_TEST_VIPS_DLL").expect("explicit libvips DLL"),
    );
    let pixels = std::path::PathBuf::from(
        std::env::var_os("AICS_TEST_INTERROGATE_PIXELS").expect("neutral fixtures"),
    );
    let native = root.path().join("native");
    std::fs::create_dir(&native).unwrap();
    let library = native.join(selected_library.file_name().unwrap());
    let vips = native.join(selected_vips.file_name().unwrap());
    std::fs::copy(selected_library, &library).unwrap();
    std::fs::copy(selected_vips, &vips).unwrap();
    let image = std::fs::read(pixels.join("square.png")).unwrap();
    let selected = model::find(&[root.path().to_owned()]).unwrap();
    let mut cached = ort_runtime::Cached::load(selected, &library).unwrap();
    let control = ort_runtime::Control::new(tokio_util::sync::CancellationToken::new());
    let output = cached.infer(&image, &vips, 0.35, &control).unwrap();
    assert_eq!(output["tags"], serde_json::json!(["blue_hair", "1girl"]));
    assert_eq!(
        output["characterTags"],
        serde_json::json!(["fixture_character"])
    );
    assert_eq!(output["scores"]["blue_hair"], 0.9);
    assert!(output["scores"].get("fixture_character").is_none());
    assert_eq!(output["rating"]["general"], 0.7);
    let strict = cached.infer(&image, &vips, 0.85, &control).unwrap();
    assert_eq!(strict["tags"], serde_json::json!(["blue_hair"]));
    control.stop();
    assert_eq!(
        cached
            .infer(&image, &vips, 0.35, &control)
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetModuleHandleW(name: *const u16) -> *mut std::ffi::c_void;
        }
        for name in [
            "DirectML.dll",
            "dxcompiler.dll",
            "dxil.dll",
            "onnxruntime_binding.node",
            "sharp-win32-x64.node",
        ] {
            let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
            assert!(
                unsafe { GetModuleHandleW(wide.as_ptr()) }.is_null(),
                "CPU-only fixture unexpectedly loaded {name}"
            );
        }
    }
    eprintln!(
        "Clean native directory contains only libvips and ONNX Runtime; no DirectML or Node binding loaded. Synthetic ONNX CPU fixture only: {}",
        output
    );
}
