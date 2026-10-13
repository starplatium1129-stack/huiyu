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
