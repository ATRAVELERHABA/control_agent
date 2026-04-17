use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    logging::{log_error, log_info},
    models::{SystemPromptSettings, UpdateSystemPromptSettingsRequest},
};

const SETTINGS_DIR_NAME: &str = "settings";
const SYSTEM_PROMPT_FILE_NAME: &str = "system-prompt.json";

#[derive(Debug)]
struct SettingsPaths {
    root_dir: PathBuf,
    system_prompt_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredSystemPromptSettings {
    #[serde(default)]
    custom_prompt: String,
}

fn settings_paths(app: &AppHandle) -> Result<SettingsPaths, String> {
    let root_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join(SETTINGS_DIR_NAME);

    Ok(SettingsPaths {
        system_prompt_file: root_dir.join(SYSTEM_PROMPT_FILE_NAME),
        root_dir,
    })
}

fn read_stored_system_prompt_settings(
    app: &AppHandle,
) -> Result<StoredSystemPromptSettings, String> {
    let paths = settings_paths(app)?;
    if !paths.system_prompt_file.exists() {
        return Ok(StoredSystemPromptSettings::default());
    }

    let raw = fs::read_to_string(&paths.system_prompt_file)
        .map_err(|error| format!("Failed to read system prompt settings: {error}"))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse system prompt settings: {error}"))
}

fn write_stored_system_prompt_settings(
    app: &AppHandle,
    payload: &StoredSystemPromptSettings,
) -> Result<(), String> {
    let paths = settings_paths(app)?;
    fs::create_dir_all(&paths.root_dir)
        .map_err(|error| format!("Failed to create settings directory: {error}"))?;

    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(payload)
            .map_err(|error| format!("Failed to serialize system prompt settings: {error}"))?
    );
    fs::write(&paths.system_prompt_file, serialized)
        .map_err(|error| format!("Failed to persist system prompt settings: {error}"))
}

pub(crate) fn get_system_prompt_settings(app: &AppHandle) -> Result<SystemPromptSettings, String> {
    let stored = read_stored_system_prompt_settings(app)?;
    Ok(SystemPromptSettings {
        custom_prompt: stored.custom_prompt,
    })
}

pub(crate) fn update_system_prompt_settings(
    app: &AppHandle,
    request: UpdateSystemPromptSettingsRequest,
) -> Result<SystemPromptSettings, String> {
    let payload = StoredSystemPromptSettings {
        custom_prompt: request.custom_prompt,
    };
    write_stored_system_prompt_settings(app, &payload)?;

    log_info(format!(
        "Updated custom system prompt settings, chars={}",
        payload.custom_prompt.chars().count()
    ));

    Ok(SystemPromptSettings {
        custom_prompt: payload.custom_prompt,
    })
}

pub(crate) fn read_custom_system_prompt(app: &AppHandle) -> Option<String> {
    match read_stored_system_prompt_settings(app) {
        Ok(stored) => {
            let trimmed = stored.custom_prompt.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(stored.custom_prompt)
            }
        }
        Err(error) => {
            log_error(format!(
                "Failed to load custom system prompt settings: {error}"
            ));
            None
        }
    }
}
