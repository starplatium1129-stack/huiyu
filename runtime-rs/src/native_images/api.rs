use libloading::Library;
use std::{
    ffi::{CStr, c_char, c_double, c_int, c_ulong, c_void},
    path::Path,
    ptr,
    sync::{Arc, Mutex, OnceLock},
};

type ImagePtr = *mut c_void;
type Unary = unsafe extern "C" fn(ImagePtr, *mut ImagePtr, ...) -> c_int;
type IntUnary = unsafe extern "C" fn(ImagePtr, *mut ImagePtr, c_int, ...) -> c_int;
type Getter = unsafe extern "C" fn(ImagePtr) -> c_int;
type LoadFile = unsafe extern "C" fn(*const c_char, *mut ImagePtr, ...) -> c_int;
type SaveBuffer = unsafe extern "C" fn(ImagePtr, *mut *mut c_void, *mut usize, ...) -> c_int;

pub(crate) struct Api {
    _library: Library,
    pub new_file: unsafe extern "C" fn(*const c_char, ...) -> ImagePtr,
    pub jpeg_file: LoadFile,
    pub webp_file: LoadFile,
    pub svg_file: LoadFile,
    pub pdf_file: LoadFile,
    pub jpeg_save: SaveBuffer,
    pub webp_save: SaveBuffer,
    pub width: Getter,
    pub height: Getter,
    pub format: Getter,
    pub interpretation: Getter,
    pub has_alpha: Getter,
    pub typeof_field: unsafe extern "C" fn(ImagePtr, *const c_char) -> usize,
    pub get_int: unsafe extern "C" fn(ImagePtr, *const c_char, *mut c_int) -> c_int,
    pub get_string: unsafe extern "C" fn(ImagePtr, *const c_char, *mut *const c_char) -> c_int,
    pub copy_memory: unsafe extern "C" fn(ImagePtr) -> ImagePtr,
    pub is_sequential: Getter,
    pub remove: unsafe extern "C" fn(ImagePtr, *const c_char) -> c_int,
    pub copy: Unary,
    pub cast: IntUnary,
    pub colourspace: IntUnary,
    pub autorot: Unary,
    pub premultiply: Unary,
    pub unpremultiply: Unary,
    pub flatten: Unary,
    pub resize: unsafe extern "C" fn(ImagePtr, *mut ImagePtr, c_double, ...) -> c_int,
    pub crop:
        unsafe extern "C" fn(ImagePtr, *mut ImagePtr, c_int, c_int, c_int, c_int, ...) -> c_int,
    pub icc: unsafe extern "C" fn(ImagePtr, *mut ImagePtr, *const c_char, ...) -> c_int,
    pub unref: unsafe extern "C" fn(*mut c_void),
    pub free: unsafe extern "C" fn(*mut c_void),
    pub progress: unsafe extern "C" fn(ImagePtr, c_int),
    pub kill: unsafe extern "C" fn(ImagePtr, c_int),
    pub signal: unsafe extern "C" fn(
        ImagePtr,
        *const c_char,
        unsafe extern "C" fn(),
        *mut c_void,
        *const c_void,
        c_int,
    ) -> c_ulong,
    pub disconnect: unsafe extern "C" fn(ImagePtr, c_ulong),
    error: unsafe extern "C" fn() -> *const c_char,
    clear_error: unsafe extern "C" fn(),
    pub srgb: c_int,
    pub rgb16: c_int,
    pub grey16: c_int,
    pub labs: c_int,
    pub cmyk: c_int,
    pub background: c_int,
    pub lanczos3: c_int,
}

pub(crate) fn get(path: &Path) -> std::result::Result<Arc<Api>, String> {
    // GLib registers process-wide types and callbacks into this DLL. Keep the
    // module mapped for the process lifetime; individual images are still freed.
    static API: OnceLock<Arc<Api>> = OnceLock::new();
    static LOADING: Mutex<()> = Mutex::new(());
    if let Some(api) = API.get() {
        return Ok(api.clone());
    }
    let _loading = LOADING.lock().unwrap();
    if let Some(api) = API.get() {
        return Ok(api.clone());
    }
    let api = Arc::new(Api::load(path)?);
    let _ = API.set(api.clone());
    Ok(api)
}
impl Api {
    fn load(path: &Path) -> std::result::Result<Self, String> {
        let library = super::library::open(path)?;
        macro_rules! symbol {
            ($name:literal, $ty:ty) => {
                unsafe {
                    *library
                        .get::<$ty>(concat!($name, "\0").as_bytes())
                        .map_err(|_| format!("Missing native symbol {}", $name))?
                }
            };
        }
        let init = symbol!("vips_init", unsafe extern "C" fn(*const c_char) -> c_int);
        if unsafe { init(c"huiyu-runtime".as_ptr()) } != 0 {
            return Err("libvips initialization failed".into());
        }
        let cache = symbol!("vips_cache_set_max", unsafe extern "C" fn(c_int));
        let concurrency = symbol!("vips_concurrency_set", unsafe extern "C" fn(c_int));
        // Disabling operation caching prevents graphs from retaining temporary
        // input files after a request ends.
        unsafe {
            cache(0);
            concurrency(
                std::thread::available_parallelism()
                    .map(|n| n.get())
                    .unwrap_or(1)
                    .min(4) as c_int,
            );
        }
        let nick = symbol!(
            "vips_enum_from_nick",
            unsafe extern "C" fn(*const c_char, usize, *const c_char) -> c_int
        );
        let interpretation = symbol!(
            "vips_interpretation_get_type",
            unsafe extern "C" fn() -> usize
        );
        let extend = symbol!("vips_extend_get_type", unsafe extern "C" fn() -> usize);
        let kernel = symbol!("vips_kernel_get_type", unsafe extern "C" fn() -> usize);
        let enum_value = |kind: unsafe extern "C" fn() -> usize, name: &CStr| unsafe {
            nick(c"huiyu".as_ptr(), kind(), name.as_ptr())
        };
        let result = Self {
            new_file: symbol!(
                "vips_image_new_from_file",
                unsafe extern "C" fn(*const c_char, ...) -> ImagePtr
            ),
            jpeg_file: symbol!("vips_jpegload", LoadFile),
            webp_file: symbol!("vips_webpload", LoadFile),
            svg_file: symbol!("vips_svgload", LoadFile),
            pdf_file: symbol!("vips_pdfload", LoadFile),
            jpeg_save: symbol!("vips_jpegsave_buffer", SaveBuffer),
            webp_save: symbol!("vips_webpsave_buffer", SaveBuffer),
            width: symbol!("vips_image_get_width", Getter),
            height: symbol!("vips_image_get_height", Getter),
            format: symbol!("vips_image_get_format", Getter),
            interpretation: symbol!("vips_image_get_interpretation", Getter),
            has_alpha: symbol!("vips_image_hasalpha", Getter),
            typeof_field: symbol!(
                "vips_image_get_typeof",
                unsafe extern "C" fn(ImagePtr, *const c_char) -> usize
            ),
            get_int: symbol!(
                "vips_image_get_int",
                unsafe extern "C" fn(ImagePtr, *const c_char, *mut c_int) -> c_int
            ),
            get_string: symbol!(
                "vips_image_get_string",
                unsafe extern "C" fn(ImagePtr, *const c_char, *mut *const c_char) -> c_int
            ),
            copy_memory: symbol!(
                "vips_image_copy_memory",
                unsafe extern "C" fn(ImagePtr) -> ImagePtr
            ),
            is_sequential: symbol!("vips_image_is_sequential", Getter),
            remove: symbol!(
                "vips_image_remove",
                unsafe extern "C" fn(ImagePtr, *const c_char) -> c_int
            ),
            copy: symbol!("vips_copy", Unary),
            cast: symbol!("vips_cast", IntUnary),
            colourspace: symbol!("vips_colourspace", IntUnary),
            autorot: symbol!("vips_autorot", Unary),
            premultiply: symbol!("vips_premultiply", Unary),
            unpremultiply: symbol!("vips_unpremultiply", Unary),
            flatten: symbol!("vips_flatten", Unary),
            resize: symbol!(
                "vips_resize",
                unsafe extern "C" fn(ImagePtr, *mut ImagePtr, c_double, ...) -> c_int
            ),
            crop: symbol!(
                "vips_extract_area",
                unsafe extern "C" fn(
                    ImagePtr,
                    *mut ImagePtr,
                    c_int,
                    c_int,
                    c_int,
                    c_int,
                    ...
                ) -> c_int
            ),
            icc: symbol!(
                "vips_icc_transform",
                unsafe extern "C" fn(ImagePtr, *mut ImagePtr, *const c_char, ...) -> c_int
            ),
            unref: symbol!("g_object_unref", unsafe extern "C" fn(*mut c_void)),
            free: symbol!("g_free", unsafe extern "C" fn(*mut c_void)),
            progress: symbol!(
                "vips_image_set_progress",
                unsafe extern "C" fn(ImagePtr, c_int)
            ),
            kill: symbol!("vips_image_set_kill", unsafe extern "C" fn(ImagePtr, c_int)),
            signal: symbol!(
                "g_signal_connect_data",
                unsafe extern "C" fn(
                    ImagePtr,
                    *const c_char,
                    unsafe extern "C" fn(),
                    *mut c_void,
                    *const c_void,
                    c_int,
                ) -> c_ulong
            ),
            disconnect: symbol!(
                "g_signal_handler_disconnect",
                unsafe extern "C" fn(ImagePtr, c_ulong)
            ),
            error: symbol!("vips_error_buffer", unsafe extern "C" fn() -> *const c_char),
            clear_error: symbol!("vips_error_clear", unsafe extern "C" fn()),
            srgb: enum_value(interpretation, c"srgb"),
            rgb16: enum_value(interpretation, c"rgb16"),
            grey16: enum_value(interpretation, c"grey16"),
            labs: enum_value(interpretation, c"labs"),
            cmyk: enum_value(interpretation, c"cmyk"),
            background: enum_value(extend, c"background"),
            lanczos3: enum_value(kernel, c"lanczos3"),
            _library: library,
        };
        if [
            result.srgb,
            result.rgb16,
            result.grey16,
            result.labs,
            result.cmyk,
            result.background,
            result.lanczos3,
        ]
        .iter()
        .any(|n| *n < 0)
        {
            return Err("Unsupported libvips enum API".into());
        }
        Ok(result)
    }
    pub fn failure(&self) -> String {
        let message = unsafe {
            let pointer = (self.error)();
            if pointer.is_null() {
                "libvips operation failed".into()
            } else {
                CStr::from_ptr(pointer).to_string_lossy().into_owned()
            }
        };
        unsafe {
            (self.clear_error)();
        }
        message
    }
    pub fn image(
        &self,
        work: impl FnOnce(*mut ImagePtr) -> c_int,
    ) -> std::result::Result<Image<'_>, String> {
        let mut out = ptr::null_mut();
        if work(&mut out) != 0 || out.is_null() {
            if !out.is_null() {
                unsafe {
                    (self.unref)(out);
                }
            }
            return Err(self.failure());
        }
        Ok(Image {
            pointer: out,
            api: self,
        })
    }
    pub fn wrap(&self, pointer: ImagePtr) -> std::result::Result<Image<'_>, String> {
        if pointer.is_null() {
            Err(self.failure())
        } else {
            Ok(Image { pointer, api: self })
        }
    }
}
pub(crate) struct Image<'a> {
    pub pointer: ImagePtr,
    pub api: &'a Api,
}
impl Drop for Image<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.api.unref)(self.pointer);
        }
    }
}
