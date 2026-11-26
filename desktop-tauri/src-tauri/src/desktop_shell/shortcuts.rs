use std::collections::HashMap;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::state::AppState;
use super::{
    focus_atelier, gateway_url, lock, toggle_companion, Bindings, PreferenceResult,
    ShellPreferences, ShellState, ShortcutConflict,
};

fn conflict(index: usize, message: impl Into<String>) -> ShortcutConflict {
    ShortcutConflict {
        index,
        message: message.into(),
    }
}

fn parsed_shortcuts(
    preferences: &ShellPreferences,
) -> (Vec<(usize, Shortcut)>, Vec<ShortcutConflict>) {
    let mut wanted = Vec::with_capacity(4);
    let mut conflicts = Vec::new();
    for (index, binding) in preferences.shortcuts.iter().enumerate() {
        let key = binding.accelerator.as_str();
        let parsed = if key.len() <= 48
            && key
                .split('+')
                .any(|part| matches!(part, "Ctrl" | "Alt" | "Super"))
        {
            key.parse::<Shortcut>().ok()
        } else {
            None
        };
        let Some(shortcut) = parsed else {
            conflicts.push(conflict(
                index,
                "请选择包含 Ctrl、Alt 或 Windows 键的有效组合键。",
            ));
            continue;
        };
        if !binding.enabled {
            continue;
        }
        if wanted
            .iter()
            .any(|&(_, prior): &(usize, Shortcut)| prior.id() == shortcut.id())
        {
            conflicts.push(conflict(
                index,
                format!("{} 已分配给绘遇的另一项操作。", key),
            ));
        } else {
            wanted.push((index, shortcut));
        }
    }
    (wanted, conflicts)
}

fn on_shortcut(
    app: &AppHandle,
    shortcut: &Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state() != ShortcutState::Pressed || crate::maintenance::active(app) {
        return;
    }
    let Some(shell) = app.try_state::<ShellState>() else {
        return;
    };
    let action = shell
        .bindings
        .try_lock()
        .ok()
        .and_then(|state| state.actions.get(&shortcut.id()).copied());
    match action {
        Some(0) => {
            let state = app.state::<AppState>();
            crate::bridge::set_ignore_mouse_events(
                app,
                !state.ignore_mouse_events.load(Ordering::Relaxed),
            );
        }
        Some(1) => toggle_companion(app),
        Some(2) => focus_atelier(app),
        Some(3) => {
            let url = gateway_url(app);
            crate::main_shared::toggle_companion_chat(app, &url);
        }
        _ => {}
    }
}

fn rollback_registrations(app: &AppHandle, bindings: &mut Bindings, added: &[(usize, Shortcut)]) {
    for &(_, shortcut) in added {
        if app.global_shortcut().unregister(shortcut).is_ok() {
            bindings.registered.remove(&shortcut.id());
        }
    }
}

pub(super) fn configure(
    app: &AppHandle,
    shell: &ShellState,
    preferences: ShellPreferences,
    startup: bool,
) -> Result<PreferenceResult, String> {
    if crate::ui_entry::isolated_profile().is_some() && !startup {
        return Err("隔离配置不注册系统快捷键。".into());
    }
    let _updating = lock(&shell.updating);
    let mut bindings = lock(&shell.bindings).clone();
    if startup && bindings.initialized {
        return Ok(PreferenceResult {
            preferences: bindings.preferences,
            conflicts: bindings.conflicts,
            saved: true,
        });
    }
    let (wanted, mut conflicts) = parsed_shortcuts(&preferences);
    let mut added = Vec::new();
    let mut actions = HashMap::new();
    let mut rejected = !conflicts.is_empty();
    if startup || conflicts.is_empty() {
        for (index, shortcut) in wanted {
            if !bindings.registered.contains_key(&shortcut.id()) {
                if app
                    .global_shortcut()
                    .on_shortcut(shortcut, on_shortcut)
                    .is_err()
                {
                    conflicts.push(conflict(
                        index,
                        format!(
                            "{} 已被其他应用或 Windows 占用。",
                            preferences.shortcuts[index].accelerator
                        ),
                    ));
                    rejected |=
                        bindings.preferences.shortcuts[index] != preferences.shortcuts[index];
                    continue;
                }
                added.push((index, shortcut));
                bindings.registered.insert(shortcut.id(), shortcut);
            }
            actions.insert(shortcut.id(), index);
        }
    }
    if !startup && rejected {
        rollback_registrations(app, &mut bindings, &added);
        let preferences = bindings.preferences.clone();
        *lock(&shell.bindings) = bindings;
        return Ok(PreferenceResult {
            preferences,
            conflicts,
            saved: false,
        });
    }
    if !startup {
        if let Err(error) = crate::maintenance_protocol::write_json(&shell.file, &preferences) {
            rollback_registrations(app, &mut bindings, &added);
            *lock(&shell.bindings) = bindings;
            app.state::<AppState>()
                .warn(&format!("Desktop preference persistence failed: {error}"));
            return Err("桌面偏好未保存，请重试。".into());
        }
    }
    bindings.registered.retain(|key, shortcut| {
        actions.contains_key(key) || app.global_shortcut().unregister(*shortcut).is_err()
    });
    bindings.actions = actions;
    bindings.preferences = preferences;
    bindings.conflicts = conflicts.clone();
    bindings.initialized = true;
    let preferences = bindings.preferences.clone();
    *lock(&shell.bindings) = bindings;
    Ok(PreferenceResult {
        preferences,
        conflicts,
        saved: true,
    })
}
