//! Frame pacing has no SDK/GPU dependency, so hidden-window waiting can be tested on office PCs.
use std::sync::mpsc::Receiver;
use std::time::Duration;

pub fn initial_fps(value: Option<&str>) -> u32 {
    value.and_then(|v| v.parse::<u32>().ok()).filter(|f| (1..=1000).contains(f)).unwrap_or(165)
}

pub fn remaining_frame_time(fps: u32, elapsed: Duration) -> Duration {
    Duration::from_micros(1_000_000 / fps.clamp(1, 1000) as u64).saturating_sub(elapsed)
}

pub fn texture_dimensions(width: u32, height: u32, scale: u32) -> (u32, u32) {
    let divisor = if matches!(scale, 2 | 4) { scale } else { 1 };
    ((width / divisor).max(1), (height / divisor).max(1))
}

/// Hidden windows wake for commands immediately, or every 100 ms to pump Win32 messages.
/// Disconnection is handled by the owning loop's existing try_recv/stopped path.
pub fn wait<T>(commands: &Receiver<T>, visible: bool, fps: u32, elapsed: Duration) -> Option<T> {
    if visible {
        std::thread::sleep(remaining_frame_time(fps, elapsed));
        None
    } else {
        commands.recv_timeout(Duration::from_millis(100)).ok()
    }
}
