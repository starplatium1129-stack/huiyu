use super::{
    model::{self, Labels, Model},
    native_library, preprocess,
};
use crate::error::{ApiError, Result};
use libloading::Library;
use ort::{
    session::{RunOptions, Session},
    value::{Tensor, TensorElementType, ValueType},
};
use serde_json::Value;
use std::{
    ffi::CStr,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

struct Runtime {
    _library: Library,
    version: String,
}
fn runtime(path: &Path) -> std::result::Result<&'static Runtime, String> {
    static RUNTIME: OnceLock<std::result::Result<Runtime, String>> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let library=native_library::open(path)?;
        let base=unsafe { let getter=library.get::<unsafe extern "system" fn()->*const ort::sys::OrtApiBase>(b"OrtGetApiBase\0").map_err(|_|"Missing ONNX Runtime C API")?;getter() };
        if base.is_null(){return Err("Missing ONNX Runtime C API".into());}
        let version=unsafe{CStr::from_ptr(((*base).GetVersionString)())}.to_string_lossy().into_owned();
        let api=unsafe{((*base).GetApi)(ort::sys::ORT_API_VERSION)};
        if api.is_null(){return Err(format!("ONNX Runtime {version} does not support API {}",ort::sys::ORT_API_VERSION));}
        // ort's documented custom-loading entry point avoids a second Windows
        // LoadLibrary call with its default (CWD-permitting) dependency search.
        if !ort::set_api(unsafe{(*api).clone()}) {return Err("ONNX Runtime was already initialized; restart before changing the native library".into());}
        ort::init().with_name("huiyu-wd14").commit();
        Ok(Runtime{_library:library,version})
    }).as_ref().map_err(Clone::clone)
}
pub(super) struct Control {
    pub cancel: CancellationToken,
    run: Mutex<Option<Arc<RunOptions>>>,
}
impl Control {
    pub fn new(cancel: CancellationToken) -> Self {
        Self {
            cancel,
            run: Mutex::new(None),
        }
    }
    pub fn stop(&self) {
        self.cancel.cancel();
        if let Some(options) = self.run.lock().unwrap().as_ref() {
            let _ = options.terminate();
        }
    }
    pub fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            Err(ApiError::new(499, "CANCELLED", "WD14 inference cancelled"))
        } else {
            Ok(())
        }
    }
}
pub(super) struct CancelRun(pub Arc<Control>);
impl Drop for CancelRun {
    fn drop(&mut self) {
        self.0.stop();
    }
}
struct ClearRun<'a>(&'a Control);
impl Drop for ClearRun<'_> {
    fn drop(&mut self) {
        self.0.run.lock().unwrap().take();
    }
}

pub(super) struct Cached {
    pub model: Model,
    labels: Labels,
    session: Session,
    input: String,
    output: String,
    version: String,
}
impl Cached {
    pub fn load(model: Model, library: &Path) -> Result<Self> {
        let loaded = runtime(library).map_err(unavailable)?;
        let labels = model::labels(&model.csv).map_err(unavailable)?;
        let session = Session::builder()
            .map_err(native_error)?
            .with_execution_providers([ort::ep::CPU::default().with_arena_allocator(true).build()])
            .map_err(native_error)?
            .commit_from_file(&model.path)
            .map_err(native_error)?;
        let input = session
            .inputs()
            .first()
            .ok_or_else(|| unavailable("WD14 model has no input"))?;
        let compatible = match input.dtype() {
            ValueType::Tensor {
                ty: TensorElementType::Float32,
                shape,
                ..
            } => {
                shape.len() == 4
                    && shape
                        .iter()
                        .zip([1, 448, 448, 3])
                        .all(|(actual, expected)| *actual == -1 || *actual == expected)
            }
            _ => false,
        };
        if !compatible || session.inputs().len() != 1 {
            return Err(unavailable("WD14 input must be float32 NHWC [1,448,448,3]"));
        }
        let input = input.name().to_owned();
        let output = session
            .outputs()
            .first()
            .ok_or_else(|| unavailable("WD14 model has no output"))?
            .name()
            .to_owned();
        Ok(Self {
            model,
            labels,
            session,
            input,
            output,
            version: loaded.version.clone(),
        })
    }
    pub fn infer(
        &mut self,
        image: &[u8],
        vips: &Path,
        threshold: f64,
        control: &Control,
    ) -> Result<Value> {
        let started = Instant::now();
        control.check()?;
        let rgb = preprocess::rgb(image, vips, &control.cancel).map_err(unavailable)?;
        let tensor = Tensor::from_array((
            [1usize, 448, 448, 3],
            preprocess::bgr(rgb).into_boxed_slice(),
        ))
        .map_err(native_error)?;
        let options = Arc::new(RunOptions::new().map_err(native_error)?);
        *control.run.lock().unwrap() = Some(options.clone());
        let _clear = ClearRun(control);
        control.check()?;
        let outputs = self
            .session
            .run_with_options(ort::inputs![self.input.as_str()=>tensor], &options)
            .map_err(native_error)?;
        control.check()?;
        let (_, probabilities) = outputs
            .get(&self.output)
            .ok_or_else(|| unavailable("Missing WD14 output"))?
            .try_extract_tensor::<f32>()
            .map_err(native_error)?;
        let mut result = model::output(
            &self.model,
            &self.labels,
            probabilities,
            threshold,
            started.elapsed().as_millis(),
        )
        .map_err(unavailable)?;
        result["meta"]["runtime"] = "rust-ort".into();
        result["meta"]["ortVersion"] = self.version.clone().into();
        Ok(result)
    }
}
fn native_error(error: impl std::fmt::Display) -> ApiError {
    unavailable(format!("ONNX Runtime: {error}"))
}
pub(super) fn unavailable(message: impl Into<String>) -> ApiError {
    ApiError::new(503, "WD14_UNAVAILABLE", message)
}
