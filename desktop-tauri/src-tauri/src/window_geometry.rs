//! Persisted rectangles use DIP; monitor work areas and native placement use pixels.
//! Keep monitor-specific scale factors: a virtual desktop rectangle includes gaps
//! and cannot describe usable space, especially with mixed display scaling.
use super::{clamp_window_bounds, WindowBounds};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayWorkArea {
    pub bounds: (i64, i64, i64, i64),
    pub scale_factor: f64,
}

pub struct WindowPlacement {
    pub logical: WindowBounds,
    pub physical: WindowBounds,
}

fn valid_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 { scale } else { 1.0 }
}

/// The 540×760 DIP pet design remains resizable. Only restore conspicuously large
/// old states (over 150% on either axis); old files cannot identify whether they
/// came from physical-pixel persistence or a deliberate resize. A deliberate
/// size above this threshold also returns to the design size at the next launch.
pub fn normalize_companion_bounds(bounds: &WindowBounds) -> WindowBounds {
    if bounds.width > 810 || bounds.height > 1140 {
        WindowBounds { width: bounds.width.min(540), height: bounds.height.min(760), ..bounds.clone() }
    } else {
        bounds.clone()
    }
}

/// Tauri's physical client-area measurements → persisted logical/DIP values.
pub fn physical_to_logical_bounds(bounds: &WindowBounds, scale_factor: f64) -> WindowBounds {
    let scale = valid_scale(scale_factor);
    WindowBounds {
        x: (bounds.x as f64 / scale).round() as i64,
        y: (bounds.y as f64 / scale).round() as i64,
        width: (bounds.width as f64 / scale).round() as i64,
        height: (bounds.height as f64 / scale).round() as i64,
    }
}

fn area_bounds(area: (i64, i64, i64, i64)) -> WindowBounds {
    WindowBounds { x: area.0, y: area.1, width: area.2, height: area.3 }
}

// Prefer the display with the largest intersection, or the nearest display if
// the old monitor disappeared. All rectangles in this selection share units.
fn target_area(bounds: &WindowBounds, areas: &[(i64, i64, i64, i64)]) -> Option<usize> {
    let (x, y) = (bounds.x as f64, bounds.y as f64);
    let (right, bottom) = (x + bounds.width.max(1) as f64, y + bounds.height.max(1) as f64);
    let mut best = None;
    let (mut best_overlap, mut best_distance) = (-1.0, f64::INFINITY);
    for (index, &(ax, ay, width, height)) in areas.iter().enumerate() {
        if width <= 0 || height <= 0 { continue; }
        let (ax, ay, ar, ab) = (ax as f64, ay as f64, (ax as f64) + width as f64, (ay as f64) + height as f64);
        let overlap = (right.min(ar) - x.max(ax)).max(0.0) * (bottom.min(ab) - y.max(ay)).max(0.0);
        let dx = (ax - right).max(x - ar).max(0.0);
        let dy = (ay - bottom).max(y - ab).max(0.0);
        let distance = dx * dx + dy * dy;
        if overlap > best_overlap || overlap == best_overlap && distance < best_distance {
            best = Some(index);
            best_overlap = overlap;
            best_distance = distance;
        }
    }
    best
}

pub fn clamp_bounds_to_work_areas(bounds: &WindowBounds, areas: &[(i64, i64, i64, i64)], min_size: Option<(i64, i64)>) -> WindowBounds {
    target_area(bounds, areas).map(|index| clamp_window_bounds(bounds, areas[index], min_size))
        .unwrap_or_else(|| bounds.clone())
}

pub fn restore_window_placement(bounds: &WindowBounds, physical_hint: Option<&WindowBounds>, monitors: &[DisplayWorkArea], min_size: Option<(i64, i64)>) -> WindowPlacement {
    let logical_areas: Vec<_> = monitors.iter().map(|monitor| {
        let area = physical_to_logical_bounds(&area_bounds(monitor.bounds), monitor.scale_factor);
        (area.x, area.y, area.width, area.height)
    }).collect();
    // Absolute DIP origins from different scales overlap. A saved physical rectangle
    // disambiguates them without depending on unstable display names or enumeration order.
    let physical_areas: Vec<_> = monitors.iter().map(|monitor| monitor.bounds).collect();
    let target = physical_hint.map(|hint| target_area(hint, &physical_areas))
        .unwrap_or_else(|| target_area(bounds, &logical_areas));
    let Some(index) = target else {
        return WindowPlacement { logical: bounds.clone(), physical: bounds.clone() };
    };
    let scale = valid_scale(monitors[index].scale_factor);
    let positioned = physical_hint.map(|hint| WindowBounds {
        x: (hint.x as f64 / scale).round() as i64,
        y: (hint.y as f64 / scale).round() as i64,
        ..bounds.clone()
    }).unwrap_or_else(|| bounds.clone());
    let logical = clamp_window_bounds(&positioned, logical_areas[index], min_size);
    let physical = WindowBounds {
        x: (logical.x as f64 * scale).round() as i64,
        y: (logical.y as f64 * scale).round() as i64,
        width: (logical.width as f64 * scale).round() as i64,
        height: (logical.height as f64 * scale).round() as i64,
    };
    // Rounding fractional DIP dimensions must not put the last pixel under a
    // taskbar. Selection is already complete; clamp against that same monitor.
    let physical = clamp_window_bounds(&physical, monitors[index].bounds, Some((1, 1)));
    WindowPlacement { logical, physical }
}
