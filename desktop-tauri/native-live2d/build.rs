//! Build script: locates the Cubism SDK for Native, compiles the official
//! C++ framework + our thin C wrapper, and links the proprietary Core static lib.
//!
//! SDK location resolution order:
//!   1. `LIVE2D_CUBISM_SDK_DIR` env var (point at the SDK root containing Core/ and Framework/)
//!   2. Workspace-local `runtime/desktop-build-sdk/CubismSdkForNative-5-r.5`
//!   3. Legacy `E:\code\CubismSdkForNative-5-r.5\CubismSdkForNative-5-r.5`

use std::path::{Path, PathBuf};

fn sdk_root() -> PathBuf {
    if let Ok(dir) = std::env::var("LIVE2D_CUBISM_SDK_DIR") {
        let p = PathBuf::from(dir);
        if valid_sdk(&p) {
            return p;
        }
        panic!("LIVE2D_CUBISM_SDK_DIR points to an incomplete Cubism Native SDK: {}", p.display());
    }
    let local = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../runtime/desktop-build-sdk/CubismSdkForNative-5-r.5");
    if valid_sdk(&local) { return local; }
    let default = Path::new("E:/code/CubismSdkForNative-5-r.5/CubismSdkForNative-5-r.5");
    if default
        .join("Core")
        .join("include")
        .join("Live2DCubismCore.h")
        .exists()
    {
        return default.to_path_buf();
    }
    panic!(
        "Live2D Cubism SDK not found. Download Cubism SDK for Native (5-r.5) from \
         https://www.live2d.com/en/sdk/download/native/ and set LIVE2D_CUBISM_SDK_DIR \
         to the SDK root (contains Core/ and Framework/)"
    )
}

fn valid_sdk(root: &Path) -> bool {
    ["Core/include/Live2DCubismCore.h", "Framework/src/CubismFramework.cpp",
        "Core/lib/windows/x86_64/143/Live2DCubismCore_MD.lib"]
        .iter().all(|part| root.join(part).exists())
}

fn main() {
    let sdk = sdk_root();
    let core_include = sdk.join("Core").join("include");
    let framework_src = sdk.join("Framework").join("src");
    println!("cargo:rerun-if-env-changed=LIVE2D_CUBISM_SDK_DIR");
    println!("cargo:rerun-if-env-changed=LIVE2D_CUBISM_SDK_SHA256");
    // Track SDK paths for direct Cargo use. The desktop entry also fingerprints
    // bytes so replacing an SDK with preserved timestamps invalidates the cache.
    println!("cargo:rerun-if-changed={}", core_include.display());
    println!("cargo:rerun-if-changed={}", framework_src.display());

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .opt_level(2)
        .include(&core_include)
        .include(&framework_src)
        .include("csrc");

    // All framework sources, except the platform rendering backends
    // (OpenGL/D3D9/D3D11/Metal/Vulkan) — we render via wgpu in Rust.
    let mut files: Vec<PathBuf> = Vec::new();
    collect_cpp(&framework_src, &mut files);
    // csmBlendMode + base renderer are needed by CubismModel / CubismFramework.
    files.push(framework_src.join("Rendering").join("csmBlendMode.cpp"));
    files.push(framework_src.join("Rendering").join("CubismRenderer.cpp"));

    for f in &files {
        build.file(f);
    }
    build.file("csrc/live2d_model.cpp");
    build.compile("live2d_native");

    // Proprietary Core static lib (Live2D Proprietary Software License Agreement).
    let core_lib = sdk
        .join("Core")
        .join("lib")
        .join("windows")
        .join("x86_64")
        .join("143");
    println!("cargo:rustc-link-search=native={}", core_lib.display());
    println!("cargo:rustc-link-lib=static=Live2DCubismCore_MD");
    println!("cargo:rerun-if-changed={}", core_lib.join("Live2DCubismCore_MD.lib").display());
    println!("cargo:rerun-if-changed=csrc");
}

fn collect_cpp(dir: &Path, out: &mut Vec<PathBuf>) {
    if !dir.is_dir() {
        return;
    }
    for entry in std::fs::read_dir(dir).expect("read framework dir") {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.is_dir() {
            if path.ends_with("Rendering") {
                continue; // platform backends + renderer excluded
            }
            collect_cpp(&path, out);
        } else if path.extension().map(|e| e == "cpp").unwrap_or(false) {
            out.push(path);
        }
    }
}
