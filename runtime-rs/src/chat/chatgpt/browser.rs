use crate::chat::{Error, Result};
use url::Url;

pub(super) fn open_system_browser(raw_url: &str) -> Result<()> {
    let parsed = Url::parse(raw_url).map_err(|_| Error::invalid("授权地址格式无效"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("auth.openai.com") {
        return Err(Error::invalid("仅允许打开 OpenAI 官方授权页面"));
    }
    launch(parsed.as_str())
}

#[cfg(windows)]
fn launch(url: &str) -> Result<()> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr::null};
    use windows_sys::Win32::UI::{
        Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL,
    };

    let verb: Vec<u16> = OsStr::new("open")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let target: Vec<u16> = OsStr::new(url)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // ShellExecuteW launches the default browser directly without cmd.exe shell parsing.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
    if (result as isize) <= 32 {
        return Err(Error::new(
            503,
            "BROWSER_LAUNCH_FAILED",
            "无法打开系统浏览器，请检查默认浏览器设置后重试",
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch(url: &str) -> Result<()> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|_| Error::new(503, "BROWSER_LAUNCH_FAILED", "无法打开系统浏览器"))?;
    Ok(())
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn launch(url: &str) -> Result<()> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map_err(|_| Error::new(503, "BROWSER_LAUNCH_FAILED", "无法打开系统浏览器"))?;
    Ok(())
}
