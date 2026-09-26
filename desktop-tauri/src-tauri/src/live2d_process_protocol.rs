//! Private parent/renderer protocol. No WebView accepts this command envelope.
use crate::live2d_renderer::OverlayRect;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const CHILD_ARGUMENT: &str = "--live2d-renderer-child";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub command: Command,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    Initialize { assets_root: String, local_root: Option<String> },
    SetCharacter { character: String, texture_scale: u32, adapter: Value },
    SetFrame {
        rect: OverlayRect,
        visible: bool,
        opacity: Option<u32>,
        framing: Option<Value>,
        companion_hwnd: Option<isize>,
    },
    GetState,
    PlayMotion { group: String, index: Option<i64>, priority: Option<String> },
    SetExpression { name: String },
    SetMouthLevel { level: f32 },
    SetEmotion { name: String, intensity: f32 },
    SetGaze { x: f32, y: f32 },
    SetMaxFps { fps: u32 },
    HitTest { x: f32, y: f32 },
    Destroy,
    Shutdown,
    /// Only exposed to the local PoC runner, never registered as a Tauri command.
    Snapshot { path: String },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum ChildMessage {
    Reply { id: u64, result: Result<Value, String> },
    Event { name: String, payload: Value },
}
