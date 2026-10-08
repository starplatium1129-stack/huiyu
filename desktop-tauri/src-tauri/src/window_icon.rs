//! Native ICO loading preserves the AND mask that Tao's RGBA conversion corrupts.
//! Keep this Windows override until the upstream conversion preserves that mask.
use std::{io, ptr, sync::Mutex};
use tauri::{WebviewWindow, WindowEvent};
use windows_sys::Win32::{
    Foundation::{HINSTANCE, HWND},
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        WindowsAndMessaging::{
            DestroyIcon, LoadImageW, SendMessageW, HICON, ICON_BIG, ICON_SMALL, IMAGE_ICON,
            SM_CXICON, SM_CXSMICON, SM_CYICON, SM_CYSMICON, WM_SETICON,
        },
    },
};

// HICON is an immutable USER handle, usable across the window/event-loop threads.
struct OwnedIcon(isize);

impl OwnedIcon {
    fn load(instance: HINSTANCE, width: i32, height: i32) -> io::Result<Self> {
        // tauri-build embeds bundle.icon under this resource ID in the host EXE.
        let resource = tauri::utils::platform::WINDOWS_APP_ICON_RESOURCE_ID as usize as *const u16;
        // Do not use LR_SHARED: its resource cache can return the first loaded
        // size for both slots. These handles belong to this window instead.
        let icon = unsafe { LoadImageW(instance, resource, IMAGE_ICON, width, height, 0) };
        if icon.is_null() { Err(io::Error::last_os_error()) } else { Ok(Self(icon as isize)) }
    }
}

impl Drop for OwnedIcon {
    fn drop(&mut self) { unsafe { DestroyIcon(self.0 as HICON); } }
}

struct WindowIcons { small: OwnedIcon, large: OwnedIcon }

impl WindowIcons {
    fn load(dpi: u32) -> io::Result<Self> {
        let instance = unsafe { GetModuleHandleW(ptr::null()) };
        if instance.is_null() { return Err(io::Error::last_os_error()); }
        let metric = |index| unsafe { GetSystemMetricsForDpi(index, dpi) };
        Ok(Self {
            small: OwnedIcon::load(instance, metric(SM_CXSMICON), metric(SM_CYSMICON))?,
            large: OwnedIcon::load(instance, metric(SM_CXICON), metric(SM_CYICON))?,
        })
    }

    fn apply(&self, hwnd: HWND) {
        // Returned old handles still belong to Tao; never destroy them here.
        unsafe {
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, self.small.0);
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, self.large.0);
        }
    }
}

/// Call once after placement, before showing each newly created window.
pub fn set_window_icons(window: &WebviewWindow) -> tauri::Result<()> {
    let hwnd = window.hwnd()?.0 as HWND;
    let icons = WindowIcons::load(unsafe { GetDpiForWindow(hwnd) })?;
    icons.apply(hwnd);
    let retained = Mutex::new(Some(icons));
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) { retained.lock().unwrap().take(); }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::{
        Graphics::Gdi::{CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP},
        UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, GetIconInfo, ICONINFO, WM_GETICON},
    };

    struct TestWindow(HWND);
    impl Drop for TestWindow { fn drop(&mut self) { unsafe { DestroyWindow(self.0); } } }
    struct IconBitmaps(ICONINFO);
    impl Drop for IconBitmaps {
        fn drop(&mut self) { unsafe { DeleteObject(self.0.hbmColor); DeleteObject(self.0.hbmMask); } }
    }

    fn pixels(bitmap: HBITMAP, size: i32) -> Vec<u8> {
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size, biHeight: -size, biPlanes: 1, biBitCount: 32,
            biCompression: BI_RGB, ..unsafe { std::mem::zeroed() }
        };
        let mut bytes = vec![0; (size * size * 4) as usize];
        let dc = unsafe { CreateCompatibleDC(ptr::null_mut()) };
        assert!(!dc.is_null());
        let rows = unsafe { GetDIBits(dc, bitmap, 0, size as u32, bytes.as_mut_ptr().cast(), &mut info, DIB_RGB_COLORS) };
        unsafe { DeleteDC(dc); }
        assert_eq!(rows, size);
        bytes
    }

    #[test]
    fn native_window_icons_preserve_transparency_in_both_slots() {
        // 200% DPI exercises distinct 32/64px resources, including the size
        // whose live Tao icon had 1,733 incorrect mask pixels in the regression.
        let icons = WindowIcons::load(192).unwrap();
        let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
        let window = TestWindow(unsafe { CreateWindowExW(0, class.as_ptr(), ptr::null(), 0,
            0, 0, 1, 1, ptr::null_mut(), ptr::null_mut(), GetModuleHandleW(ptr::null()), ptr::null()) });
        assert!(!window.0.is_null());
        icons.apply(window.0);
        for (slot, size) in [(ICON_SMALL, 32), (ICON_BIG, 64)] {
            let handle = unsafe { SendMessageW(window.0, WM_GETICON, slot as usize, 0) } as HICON;
            assert!(!handle.is_null());
            let mut bitmaps = IconBitmaps(unsafe { std::mem::zeroed() });
            assert_ne!(unsafe { GetIconInfo(handle, &mut bitmaps.0) }, 0);
            let color = pixels(bitmaps.0.hbmColor, size);
            let mask = pixels(bitmaps.0.hbmMask, size);
            assert!(color.chunks_exact(4).any(|pixel| pixel[3] == 0));
            assert!(color.chunks_exact(4).any(|pixel| pixel[3] == 255));
            let mismatches = color.chunks_exact(4).zip(mask.chunks_exact(4))
                .filter(|(color, mask)| (color[3] == 0) != (mask[0] == 255)).count();
            assert_eq!(mismatches, 0, "{size}px native transparency mask is corrupt");
        }
        // The hidden HWND is destroyed before its owned icons leave scope.
        drop(window);
    }
}
