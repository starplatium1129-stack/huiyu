//! Keep hidden documents responsive to host messages and in-flight work while
//! letting WebView2 trim memory. Suspending them would also stop those scripts.
use tauri::{Emitter, WebviewWindow};
use webview2_com::{
    IsDocumentPlayingAudioChangedEventHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_19, ICoreWebView2_8,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    },
};
use windows_core::{Interface, BOOL};
use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindowVisible};

fn update(core: &ICoreWebView2, hwnd: isize) {
    let Ok(memory) = core.cast::<ICoreWebView2_19>() else { return; };
    let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;
    let visible = unsafe { IsWindowVisible(hwnd) != 0 && IsIconic(hwnd) == 0 };
    let audio_active = !visible && core.cast::<ICoreWebView2_8>().map_or(true, |audio| {
        let mut playing = BOOL::default();
        unsafe { audio.IsDocumentPlayingAudio(&mut playing) }.is_err() || playing.as_bool()
    });
    let target = if visible || audio_active {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    };
    unsafe {
        let mut current = target;
        if memory.MemoryUsageTargetLevel(&mut current).is_err() || current != target {
            let _ = memory.SetMemoryUsageTargetLevel(target);
        }
    }
}

pub fn install(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return; };
    let hwnd = hwnd.0 as isize;
    let _ = window.with_webview(move |view| {
        let Ok(core) = (unsafe { view.controller().CoreWebView2() }) else { return; };
        let Ok(audio) = core.cast::<ICoreWebView2_8>() else { return; };
        let handler = IsDocumentPlayingAudioChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender { update(&core, hwnd); }
            Ok(())
        }));
        // WebView2 owns this callback for exactly the lifetime of the controller.
        // It captures only the HWND value, so it cannot keep the window alive.
        let mut token = 0;
        let _ = unsafe { audio.add_IsDocumentPlayingAudioChanged(&handler, &mut token) };
    });
}

pub fn refresh(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return; };
    let hwnd = hwnd.0 as isize;
    let _ = window.with_webview(move |view| {
        if let Ok(core) = unsafe { view.controller().CoreWebView2() } {
            update(&core, hwnd);
        }
    });
}

pub fn visibility(window: &WebviewWindow, visible: bool) {
    let name = match window.label() {
        "atelier" => "aics:atelier-visibility",
        "companion" => "aics:companion-visibility",
        "companion-chat" => "aics:companion-chat-visibility",
        _ => return,
    };
    let _ = window.emit_to(window.label(), name, visible);
    refresh(window);
}
