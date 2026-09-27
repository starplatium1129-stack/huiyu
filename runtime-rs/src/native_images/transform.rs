use super::api::{self, Api, Image};
use std::{
    ffi::{CStr, CString, c_int, c_void},
    path::Path,
    ptr,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

type Result<T> = std::result::Result<T, String>;
struct Evaluation<'a> {
    api: &'a Api,
    cancel: &'a CancellationToken,
    started: Instant,
}
unsafe extern "C" fn progress(image: *mut c_void, _: *mut c_void, data: *mut c_void) {
    let state = unsafe { &*(data as *const Evaluation<'_>) };
    if state.cancel.is_cancelled() || state.started.elapsed() > Duration::from_secs(5) {
        unsafe {
            (state.api.kill)(image, 1);
        }
    }
}
fn cast<'a>(api: &'a Api, image: &Image<'_>, format: c_int) -> Result<Image<'a>> {
    api.image(|out| unsafe { (api.cast)(image.pointer, out, format, ptr::null::<c_void>()) })
}
fn dimensions(api: &Api, image: &Image<'_>) -> (i32, i32) {
    unsafe { ((api.width)(image.pointer), (api.height)(image.pointer)) }
}
fn load<'a>(api: &'a Api, file: &CStr) -> Result<Image<'a>> {
    api.wrap(unsafe {
        (api.new_file)(
            file.as_ptr(),
            c"access".as_ptr(),
            1i32,
            c"fail_on".as_ptr(),
            3i32,
            ptr::null::<c_void>(),
        )
    })
}
fn colour<'a>(api: &'a Api, mut image: Image<'a>) -> Result<Image<'a>> {
    let interpretation = unsafe { (api.interpretation)(image.pointer) };
    let sixteen = interpretation == api.rgb16 || interpretation == api.grey16;
    let target = if interpretation == api.rgb16 {
        c"p3"
    } else {
        c"srgb"
    };
    if unsafe { (api.typeof_field)(image.pointer, c"icc-profile-data".as_ptr()) } != 0
        && interpretation != api.labs
        && interpretation != api.grey16
    {
        if let Ok(converted) = api.image(|out| unsafe {
            (api.icc)(
                image.pointer,
                out,
                target.as_ptr(),
                c"embedded".as_ptr(),
                1i32,
                c"depth".as_ptr(),
                if sixteen { 16i32 } else { 8i32 },
                c"intent".as_ptr(),
                0i32,
                ptr::null::<c_void>(),
            )
        }) {
            image = converted;
        }
    } else if interpretation == api.cmyk {
        image = api.image(|out| unsafe {
            (api.icc)(
                image.pointer,
                out,
                target.as_ptr(),
                c"input_profile".as_ptr(),
                c"cmyk".as_ptr(),
                c"intent".as_ptr(),
                0i32,
                ptr::null::<c_void>(),
            )
        })?;
    }
    Ok(image)
}
fn shrink_load<'a>(api: &'a Api, file: &CStr, image: Image<'a>, shrink: f64) -> Result<Image<'a>> {
    let mut loader = ptr::null();
    if unsafe { (api.get_string)(image.pointer, c"vips-loader".as_ptr(), &mut loader) } != 0
        || loader.is_null()
    {
        return Ok(image);
    }
    let name = unsafe { CStr::from_ptr(loader) }.to_bytes();
    if name.starts_with(b"jpeg") {
        let mut factor = if shrink >= 8.0 {
            8
        } else if shrink >= 4.0 {
            4
        } else if shrink >= 2.0 {
            2
        } else {
            1
        };
        if factor > 1 && shrink as i32 == factor {
            factor /= 2;
        }
        if factor > 1 {
            return api.image(|out| unsafe {
                (api.jpeg_file)(
                    file.as_ptr(),
                    out,
                    c"shrink".as_ptr(),
                    factor,
                    c"access".as_ptr(),
                    1i32,
                    c"fail_on".as_ptr(),
                    3i32,
                    ptr::null::<c_void>(),
                )
            });
        }
    } else if name.starts_with(b"webp") && shrink > 1.0 {
        return api.image(|out| unsafe {
            (api.webp_file)(
                file.as_ptr(),
                out,
                c"scale".as_ptr(),
                1.0 / shrink,
                c"access".as_ptr(),
                1i32,
                c"fail_on".as_ptr(),
                3i32,
                ptr::null::<c_void>(),
            )
        });
    } else if shrink != 1.0 {
        {
            let load = if name.starts_with(b"svg") {
                Some(api.svg_file)
            } else if name.starts_with(b"pdf") {
                Some(api.pdf_file)
            } else {
                None
            };
            if let Some(load) = load {
                return api.image(|out| unsafe {
                    load(
                        file.as_ptr(),
                        out,
                        c"scale".as_ptr(),
                        1.0 / shrink,
                        c"access".as_ptr(),
                        1i32,
                        c"fail_on".as_ptr(),
                        3i32,
                        ptr::null::<c_void>(),
                    )
                });
            }
        }
    }
    Ok(image)
}
fn encode(api: &Api, image: &Image<'_>, webp: bool, cancel: &CancellationToken) -> Result<Vec<u8>> {
    if cancel.is_cancelled() {
        return Err("Image operation cancelled".into());
    }
    let mut state = Evaluation {
        api,
        cancel,
        started: Instant::now(),
    };
    let callback: unsafe extern "C" fn() = unsafe {
        std::mem::transmute(progress as unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void))
    };
    unsafe {
        (api.progress)(image.pointer, 1);
    }
    let signal = unsafe {
        (api.signal)(
            image.pointer,
            c"eval".as_ptr(),
            callback,
            (&mut state as *mut Evaluation<'_>).cast(),
            ptr::null(),
            0,
        )
    };
    let mut memory = ptr::null_mut();
    let mut length = 0usize;
    let status = if webp {
        unsafe {
            (api.webp_save)(
                image.pointer,
                &mut memory,
                &mut length,
                c"keep".as_ptr(),
                0i32,
                c"Q".as_ptr(),
                80i32,
                c"lossless".as_ptr(),
                1i32,
                c"effort".as_ptr(),
                3i32,
                c"exact".as_ptr(),
                0i32,
                ptr::null::<c_void>(),
            )
        }
    } else {
        unsafe {
            (api.jpeg_save)(
                image.pointer,
                &mut memory,
                &mut length,
                c"keep".as_ptr(),
                0i32,
                c"Q".as_ptr(),
                82i32,
                c"subsample_mode".as_ptr(),
                1i32,
                c"optimize_coding".as_ptr(),
                1i32,
                ptr::null::<c_void>(),
            )
        }
    };
    unsafe {
        (api.disconnect)(image.pointer, signal);
    }
    let result = if status != 0 || memory.is_null() {
        Err(api.failure())
    } else if cancel.is_cancelled() {
        Err("Image operation cancelled".into())
    } else {
        Ok(unsafe { std::slice::from_raw_parts(memory.cast::<u8>(), length) }.to_vec())
    };
    if !memory.is_null() {
        unsafe {
            (api.free)(memory);
        }
    }
    result
}

/// Exact sharp geometry and encoder options used by live2d-textures.ts.
pub(crate) fn atlas(
    path: &Path,
    library: &Path,
    scale: i32,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    if ![2, 4].contains(&scale) {
        return Err("Invalid texture scale".into());
    }
    transform(path, library, Some(scale), cancel)?.ok_or_else(|| "Invalid atlas dimensions".into())
}
/// Matches workspace thumbnails: auto-orient, width <=560, black flatten, JPEG82.
pub(crate) fn thumbnail(
    path: &Path,
    library: &Path,
    cancel: &CancellationToken,
) -> Result<Option<Vec<u8>>> {
    transform(path, library, None, cancel)
}
fn transform(
    path: &Path,
    library: &Path,
    scale: Option<i32>,
    cancel: &CancellationToken,
) -> Result<Option<Vec<u8>>> {
    if cancel.is_cancelled() {
        return Err("Image operation cancelled".into());
    }
    let api = api::get(library)?;
    // Keep file decoding demand-driven; large compressed originals never need
    // a second full-file heap copy just to produce a thumbnail or atlas.
    let file = CString::new(path.to_str().ok_or("Image path is not UTF-8")?)
        .map_err(|_| "Invalid image path")?;
    let mut image = load(&api, &file)?;
    let (width, height) = dimensions(&api, &image);
    let limit = if scale.is_some() {
        268_402_689
    } else {
        32 * 1024 * 1024
    };
    if width < 1
        || height < 1
        || i64::from(width) * i64::from(height) > limit
        || scale.is_none() && (width > 8192 || height > 8192)
    {
        return Ok(None);
    }
    let mut orientation = 0;
    if scale.is_none() && unsafe { (api.typeof_field)(image.pointer, c"orientation".as_ptr()) } != 0
    {
        unsafe {
            (api.get_int)(image.pointer, c"orientation".as_ptr(), &mut orientation);
        }
    }
    let swapped = matches!(orientation, 5..=8);
    let target = scale.map(|n| ((width / n).max(1), (height / n).max(1)));
    let factor = |w: i32, h: i32| match target {
        Some((tw, th)) => (f64::from(w) / f64::from(tw)).min(f64::from(h) / f64::from(th)),
        None => (f64::from(if swapped { h } else { w }) / 560.0).max(1.0),
    };
    image = shrink_load(&api, &file, image, factor(width, height))?;
    image = colour(&api, image)?;
    // Sharp performs flatten before resize (calling order in JS does not move it).
    if scale.is_none() && unsafe { (api.has_alpha)(image.pointer) } != 0 {
        image =
            api.image(|out| unsafe { (api.flatten)(image.pointer, out, ptr::null::<c_void>()) })?;
    }
    let (w, h) = dimensions(&api, &image);
    let shrink = factor(w, h);
    let resize = shrink != 1.0;
    let original = unsafe { (api.format)(image.pointer) };
    let premultiply = resize && unsafe { (api.has_alpha)(image.pointer) } != 0;
    if premultiply {
        let multiplied = api
            .image(|out| unsafe { (api.premultiply)(image.pointer, out, ptr::null::<c_void>()) })?;
        image = cast(&api, &multiplied, original)?;
    }
    if resize {
        image = api.image(|out| unsafe {
            (api.resize)(
                image.pointer,
                out,
                1.0 / shrink.min(f64::from(w)),
                c"vscale".as_ptr(),
                1.0 / shrink.min(f64::from(h)),
                c"kernel".as_ptr(),
                api.lanczos3,
                ptr::null::<c_void>(),
            )
        })?;
    }
    if scale.is_none() {
        if orientation > 1 && unsafe { (api.is_sequential)(image.pointer) } != 0 {
            let mut state = Evaluation {
                api: &api,
                cancel,
                started: Instant::now(),
            };
            unsafe {
                (api.progress)(image.pointer, 1);
            }
            let callback: unsafe extern "C" fn() = unsafe {
                std::mem::transmute(
                    progress as unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void),
                )
            };
            let signal = unsafe {
                (api.signal)(
                    image.pointer,
                    c"eval".as_ptr(),
                    callback,
                    (&mut state as *mut Evaluation<'_>).cast(),
                    ptr::null(),
                    0,
                )
            };
            let copied = api.wrap(unsafe { (api.copy_memory)(image.pointer) });
            unsafe {
                (api.disconnect)(image.pointer, signal);
            }
            let copied = copied?;
            image =
                api.image(|out| unsafe { (api.copy)(copied.pointer, out, ptr::null::<c_void>()) })?;
            unsafe {
                (api.remove)(image.pointer, c"sequential".as_ptr());
            }
        }
        image =
            api.image(|out| unsafe { (api.autorot)(image.pointer, out, ptr::null::<c_void>()) })?;
    }
    if let Some((tw, th)) = target {
        let (w, h) = dimensions(&api, &image);
        if (w, h) != (tw, th) {
            image = api.image(|out| unsafe {
                (api.crop)(
                    image.pointer,
                    out,
                    ((w - tw + 1) / 2).max(0),
                    ((h - th + 1) / 2).max(0),
                    tw,
                    th,
                    ptr::null::<c_void>(),
                )
            })?;
        }
    }
    if premultiply {
        let straight = api.image(|out| unsafe {
            (api.unpremultiply)(image.pointer, out, ptr::null::<c_void>())
        })?;
        image = cast(&api, &straight, original)?;
    }
    let interpretation = unsafe { (api.interpretation)(image.pointer) };
    if interpretation == api.rgb16 || interpretation == api.grey16 {
        image = cast(&api, &image, 2)?;
    }
    if interpretation != api.srgb {
        image = api.image(|out| unsafe {
            (api.colourspace)(
                image.pointer,
                out,
                api.srgb,
                c"source_space".as_ptr(),
                interpretation,
                ptr::null::<c_void>(),
            )
        })?;
    }
    encode(&api, &image, scale.is_some(), cancel).map(Some)
}
