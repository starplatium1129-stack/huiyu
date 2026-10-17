//! Native Live2D runtime for the AI-CG-Studio desktop shell.
//!
//! Official Cubism SDK for Native 5-r.5 framework (compiled from the C++ SDK)
//! behind a small C API, wrapped safely for Rust, with a wgpu renderer that
//! reproduces the official GLES2 renderer semantics.

mod ffi;
pub mod model;
pub mod renderer;
