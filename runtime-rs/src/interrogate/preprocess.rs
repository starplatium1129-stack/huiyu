use super::vips_api::{self, Api, Image};
use std::{
    ffi::{CStr, c_int, c_void},
    path::Path,
    ptr,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const SIZE: i32 = 448;
type Result<T> = std::result::Result<T, String>;
struct Evaluation<'a> {
    api: &'a Api,
    started: Instant,
    cancel: &'a CancellationToken,
}
unsafe extern "C" fn progress(image: *mut c_void, _progress: *mut c_void, context: *mut c_void) {
    // The context lives through synchronous write_to_memory and is disconnected
    // before being dropped. This callback does not read the C progress layout.
    let context = unsafe { &*(context as *const Evaluation<'_>) };
    if context.cancel.is_cancelled() || context.started.elapsed() >= Duration::from_secs(5) {
        unsafe {
            (context.api.kill)(image, 1);
        }
    }
}
fn check(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err("Image preprocessing cancelled".into())
    } else {
        Ok(())
    }
}
fn cast<'a>(api: &'a Api, image: &Image<'_>, format: c_int) -> Result<Image<'a>> {
    api.image(|out| unsafe { (api.cast)(image.pointer, out, format, ptr::null::<c_void>()) })
}

/// Fixed sharp 0.35.4 pipeline from interrogate-engine.ts. No user image is
/// written to disk; every graph/image and output allocation has an explicit owner.
pub(super) fn rgb(bytes: &[u8], library: &Path, cancel: &CancellationToken) -> Result<Vec<u8>> {
    let api = vips_api::get(library)?;
    check(cancel)?;
    let mut image = api.wrap(unsafe {
        (api.new_buffer)(
            bytes.as_ptr().cast(),
            bytes.len(),
            c"".as_ptr(),
            c"access".as_ptr(),
            1i32,
            c"fail_on".as_ptr(),
            3i32,
            ptr::null::<c_void>(),
        )
    })?;
    let dimensions =
        |image: &Image<'_>| unsafe { ((api.width)(image.pointer), (api.height)(image.pointer)) };
    let (width, height) = dimensions(&image);
    let bands = unsafe { (api.bands)(image.pointer) };
    if width < 1
        || height < 1
        || width > 8192
        || height > 8192
        || i64::from(width) * i64::from(height) > 32 * 1024 * 1024
        || bands > 5
    {
        return Err("Image exceeds WD14 decode limits".into());
    }
    // Match sharp's default fastShrinkOnLoad, including libjpeg's exact-integer
    // rounding workaround. WebP uses decoder-side scale before the final resize.
    let shrink = (f64::from(width) / f64::from(SIZE)).max(f64::from(height) / f64::from(SIZE));
    if bytes.starts_with(b"\xff\xd8\xff") {
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
            image = api.image(|out| unsafe {
                (api.jpeg)(
                    bytes.as_ptr().cast(),
                    bytes.len(),
                    out,
                    c"shrink".as_ptr(),
                    factor,
                    c"access".as_ptr(),
                    1i32,
                    c"fail_on".as_ptr(),
                    3i32,
                    ptr::null::<c_void>(),
                )
            })?;
        }
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") && shrink > 1.0 {
        image = api.image(|out| unsafe {
            (api.webp)(
                bytes.as_ptr().cast(),
                bytes.len(),
                out,
                c"scale".as_ptr(),
                1.0 / shrink,
                c"access".as_ptr(),
                1i32,
                c"fail_on".as_ptr(),
                3i32,
                ptr::null::<c_void>(),
            )
        })?;
    } else if shrink != 1.0 {
        let mut loader = ptr::null();
        if unsafe { (api.get_string)(image.pointer, c"vips-loader".as_ptr(), &mut loader) } == 0
            && !loader.is_null()
        {
            let name = unsafe { CStr::from_ptr(loader) }.to_bytes();
            let load = if name.starts_with(b"svg") {
                Some(api.svg)
            } else if name.starts_with(b"pdf") {
                Some(api.pdf)
            } else {
                None
            };
            if let Some(load) = load {
                image = api.image(|out| unsafe {
                    load(
                        bytes.as_ptr().cast(),
                        bytes.len(),
                        out,
                        c"scale".as_ptr(),
                        1.0 / shrink,
                        c"access".as_ptr(),
                        1i32,
                        c"fail_on".as_ptr(),
                        3i32,
                        ptr::null::<c_void>(),
                    )
                })?;
            }
        }
    }
    let interpretation = unsafe { (api.interpretation)(image.pointer) };
    let sixteen = interpretation == api.rgb16 || interpretation == api.grey16;
    let target_profile = if interpretation == api.rgb16 {
        c"p3"
    } else {
        c"srgb"
    };
    let icc = unsafe { (api.typeof_field)(image.pointer, c"icc-profile-data".as_ptr()) } != 0;
    if icc && interpretation != api.labs && interpretation != api.grey16 {
        // sharp retains the original image when an embedded ICC is malformed.
        if let Ok(converted) = api.image(|out| unsafe {
            (api.icc)(
                image.pointer,
                out,
                target_profile.as_ptr(),
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
                target_profile.as_ptr(),
                c"input_profile".as_ptr(),
                c"cmyk".as_ptr(),
                c"intent".as_ptr(),
                0i32,
                ptr::null::<c_void>(),
            )
        })?;
    }
    check(cancel)?;
    let (width, height) = dimensions(&image);
    let shrink = (f64::from(width) / f64::from(SIZE)).max(f64::from(height) / f64::from(SIZE));
    let horizontal = shrink.min(f64::from(width));
    let vertical = shrink.min(f64::from(height));
    let resize = horizontal != 1.0 || vertical != 1.0;
    let original_format = unsafe { (api.format)(image.pointer) };
    let premultiply = resize && unsafe { (api.has_alpha)(image.pointer) } != 0;
    if premultiply {
        let multiplied = api
            .image(|out| unsafe { (api.premultiply)(image.pointer, out, ptr::null::<c_void>()) })?;
        image = cast(&api, &multiplied, original_format)?;
    }
    if resize {
        image = api.image(|out| unsafe {
            (api.resize)(
                image.pointer,
                out,
                1.0 / horizontal,
                c"vscale".as_ptr(),
                1.0 / vertical,
                c"kernel".as_ptr(),
                api.lanczos3,
                ptr::null::<c_void>(),
            )
        })?;
    }
    image = api.image(|out| unsafe { (api.autorot)(image.pointer, out, ptr::null::<c_void>()) })?;
    let (width, height) = dimensions(&image);
    if width != SIZE || height != SIZE {
        let interpretation = unsafe { (api.interpretation)(image.pointer) };
        let multiplier = if interpretation == api.rgb16 || interpretation == api.grey16 {
            256.0
        } else {
            1.0
        };
        let count = unsafe { (api.bands)(image.pointer) } as usize;
        let background = vec![255.0 * multiplier; count];
        let array = unsafe { (api.array)(background.as_ptr(), count as c_int) };
        if array.is_null() {
            return Err("Cannot allocate padding color".into());
        }
        let embedded = api.image(|out| unsafe {
            (api.embed)(
                image.pointer,
                out,
                (SIZE - width) / 2,
                (SIZE - height) / 2,
                SIZE.max(width),
                SIZE.max(height),
                c"extend".as_ptr(),
                api.background,
                c"background".as_ptr(),
                array,
                ptr::null::<c_void>(),
            )
        });
        unsafe {
            (api.area_unref)(array);
        }
        image = embedded?;
    }
    if premultiply {
        let straight = api.image(|out| unsafe {
            (api.unpremultiply)(image.pointer, out, ptr::null::<c_void>())
        })?;
        image = cast(&api, &straight, original_format)?;
    }
    while unsafe { (api.has_alpha)(image.pointer) } != 0
        && unsafe { (api.bands)(image.pointer) } > 1
    {
        image = api.image(|out| unsafe {
            (api.extract_band)(
                image.pointer,
                out,
                0i32,
                c"n".as_ptr(),
                (api.bands)(image.pointer) - 1,
                ptr::null::<c_void>(),
            )
        })?;
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
    if unsafe { (api.format)(image.pointer) } != 0 {
        image = cast(&api, &image, 0)?;
    }
    if dimensions(&image) != (SIZE, SIZE) || unsafe { (api.bands)(image.pointer) } != 3 {
        return Err("Unexpected WD14 RGB geometry".into());
    }
    check(cancel)?;
    let mut context = Evaluation {
        api: &api,
        started: Instant::now(),
        cancel,
    };
    unsafe {
        (api.progress)(image.pointer, 1);
    }
    let callback: unsafe extern "C" fn() = unsafe {
        std::mem::transmute(progress as unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void))
    };
    let signal = unsafe {
        (api.signal)(
            image.pointer,
            c"eval".as_ptr(),
            callback,
            (&mut context as *mut Evaluation<'_>).cast(),
            ptr::null(),
            0,
        )
    };
    let mut length = 0;
    let memory = unsafe { (api.memory)(image.pointer, &mut length) };
    unsafe {
        (api.disconnect)(image.pointer, signal);
    }
    if memory.is_null() {
        return Err(api.failure());
    }
    let result = if length != (SIZE * SIZE * 3) as usize {
        Err("Unexpected WD14 RGB byte count".into())
    } else {
        Ok(unsafe { std::slice::from_raw_parts(memory.cast::<u8>(), length) }.to_vec())
    };
    unsafe {
        (api.free)(memory);
    }
    check(cancel)?;
    result
}
pub(super) fn bgr(rgb: Vec<u8>) -> Vec<f32> {
    let mut output = Vec::with_capacity(rgb.len());
    for pixel in rgb.as_chunks::<3>().0 {
        output.extend([
            f32::from(pixel[2]),
            f32::from(pixel[1]),
            f32::from(pixel[0]),
        ]);
    }
    output
}
