/// The gateway only serves HTTP on IPv4 loopback. Cache its parsed port
/// alongside the URL so an IPC origin check needs neither parsing nor allocation.
#[derive(Default)]
pub(crate) struct Endpoint {
    pub(crate) url: String,
    pub(crate) origin: Option<LoopbackOrigin>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) struct LoopbackOrigin(pub(crate) u16);

impl LoopbackOrigin {
    pub(crate) fn from_url(url: &tauri::Url) -> Option<Self> {
        if url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
            && url.username().is_empty() && url.password().is_none() {
            url.port_or_known_default().map(Self)
        } else {
            None
        }
    }
}
