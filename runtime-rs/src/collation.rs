/// Node/V8 maps ICU's C/POSIX fallback to en-US. sys-locale already strips
/// the encoding from C.UTF-8; this applies only to the host default, never
/// to an explicit locale persisted in a task ledger.
/// https://github.com/nodejs/node/blob/v24.18.0/deps/v8/src/execution/isolate.cc#L6711
pub(crate) fn normalize_system_locale(locale: &str) -> &str {
    if ["C", "POSIX", "en-US-POSIX"]
        .iter()
        .any(|fallback| locale.eq_ignore_ascii_case(fallback))
    {
        "en-US"
    } else {
        locale
    }
}

pub(crate) fn system_locale() -> String {
    let locale = sys_locale::get_locale().unwrap_or_else(|| "en-US".into());
    normalize_system_locale(&locale).into()
}
