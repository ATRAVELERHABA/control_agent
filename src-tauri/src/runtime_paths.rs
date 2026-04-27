//! Runtime path resolution for bundled resources and per-user data.

use std::{
    env,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use tauri::{AppHandle, Manager};

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static EXECUTABLE_DIR: OnceLock<PathBuf> = OnceLock::new();

fn push_unique(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Failed to resolve resource directory: {error}"))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
    let executable_dir = env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| resource_dir.clone());

    let _ = RESOURCE_DIR.set(resource_dir);
    let _ = APP_DATA_DIR.set(app_data_dir);
    let _ = EXECUTABLE_DIR.set(executable_dir);

    Ok(())
}

pub(crate) fn resource_dir() -> Option<PathBuf> {
    RESOURCE_DIR.get().cloned()
}

pub(crate) fn app_data_dir() -> Option<PathBuf> {
    APP_DATA_DIR.get().cloned()
}

pub(crate) fn executable_dir() -> Option<PathBuf> {
    EXECUTABLE_DIR.get().cloned()
}

pub(crate) fn content_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Some(resource_dir) = resource_dir() {
        push_unique(&mut candidates, resource_dir);
    }

    if let Some(executable_dir) = executable_dir() {
        push_unique(&mut candidates, executable_dir.clone());

        if let Some(parent) = executable_dir.parent() {
            push_unique(&mut candidates, parent.to_path_buf());
        }
    }

    if let Ok(current_dir) = env::current_dir() {
        push_unique(&mut candidates, current_dir.clone());

        if let Some(parent) = current_dir.parent() {
            push_unique(&mut candidates, parent.to_path_buf());
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_unique(&mut candidates, manifest_dir.clone());

    if let Some(parent) = manifest_dir.parent() {
        push_unique(&mut candidates, parent.to_path_buf());
    }

    candidates
}

pub(crate) fn config_root_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Some(app_data_dir) = app_data_dir() {
        push_unique(&mut candidates, app_data_dir);
    }

    for candidate in content_root_candidates() {
        push_unique(&mut candidates, candidate);
    }

    candidates
}
