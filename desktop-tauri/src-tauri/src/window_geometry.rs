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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_4k_175_percent_state_returns_to_pet_design_size() {
        let saved = WindowBounds { x: 1299, y: 3, width: 1103, height: 1234 };
        let result = restore_window_placement(&normalize_companion_bounds(&saved), None,
            &[DisplayWorkArea { bounds: (0, 0, 3840, 2160), scale_factor: 1.75 }], None);
        assert_eq!(result.logical, WindowBounds { x: 1299, y: 3, width: 540, height: 760 });
        assert_eq!(result.physical, WindowBounds { x: 2273, y: 5, width: 945, height: 1330 });
    }

    #[test]
    fn normal_and_smaller_custom_pet_sizes_remain_unchanged() {
        for (width, height) in [(540, 760), (600, 850), (400, 500)] {
            let bounds = WindowBounds { x: 30, y: 40, width, height };
            assert_eq!(normalize_companion_bounds(&bounds), bounds);
        }
        let narrow = normalize_companion_bounds(&WindowBounds { x: 30, y: 40, width: 400, height: 1234 });
        assert_eq!((narrow.width, narrow.height), (400, 760));
    }

    #[test]
    fn display_work_areas_exclude_taskbars_and_negative_coordinate_gaps() {
        let areas = [(-1920, 500, 1920, 1040), (0, 0, 3840, 2080)];
        let in_gap = WindowBounds { x: -900, y: 100, width: 540, height: 760 };
        let clamped = clamp_bounds_to_work_areas(&in_gap, &areas, None);
        assert_eq!((clamped.x, clamped.y), (-900, 500));
        let under_taskbar = WindowBounds { x: 3500, y: 1900, width: 540, height: 760 };
        let clamped = clamp_bounds_to_work_areas(&under_taskbar, &areas, None);
        assert_eq!((clamped.x, clamped.y), (3300, 1320));
        let disconnected = WindowBounds { x: -2500, y: 800, width: 1100, height: 1600 };
        let clamped = clamp_bounds_to_work_areas(&disconnected, &[(0, 0, 1920, 1040)], None);
        assert_eq!(clamped, WindowBounds { x: 0, y: 0, width: 1100, height: 1040 });
    }

    #[test]
    fn each_display_uses_its_own_dpi_and_minimum_fits_small_work_area() {
        let monitors = [DisplayWorkArea { bounds: (0, 0, 3840, 2080), scale_factor: 1.75 },
            DisplayWorkArea { bounds: (-1920, 0, 1920, 1040), scale_factor: 1.0 }];
        let saved = WindowBounds { x: -1500, y: 100, width: 600, height: 850 };
        let placed = restore_window_placement(&saved, None, &monitors, None);
        assert_eq!(placed.logical, saved);
        assert_eq!(placed.physical, saved);
        let small = restore_window_placement(&WindowBounds { x: 100, y: 100, width: 1440, height: 960 }, None,
            &[DisplayWorkArea { bounds: (0, 0, 1920, 1040), scale_factor: 1.75 }], Some((1024, 720)));
        assert!(small.physical.width <= 1920 && small.physical.height <= 1040);
        assert!(small.logical.height < 720);
    }
    #[test]
    fn physical_hint_disambiguates_overlapping_dip_origins_and_survives_dpi_changes() {
        let primary = DisplayWorkArea { bounds: (0, 0, 3840, 2080), scale_factor: 1.0 };
        let right = DisplayWorkArea { bounds: (3840, 0, 3840, 2080), scale_factor: 2.0 };
        let physical = WindowBounds { x: 4000, y: 200, width: 1080, height: 1520 };
        let saved = physical_to_logical_bounds(&physical, 2.0);
        for monitors in [[primary, right], [right, primary]] {
            let placed = restore_window_placement(&saved, Some(&physical), &monitors, None);
            assert_eq!(placed.logical, saved);
            assert_eq!(placed.physical, physical);
        }
        let changed = DisplayWorkArea { scale_factor: 1.0, ..right };
        let placed = restore_window_placement(&saved, Some(&physical), &[primary, changed], None);
        assert_eq!(placed.physical, WindowBounds { x: 4000, y: 200, width: 540, height: 760 });
        let removed = restore_window_placement(&saved, Some(&physical), &[primary], None);
        assert_eq!(removed.physical, WindowBounds { x: 3300, y: 200, width: 540, height: 760 });
    }

}
