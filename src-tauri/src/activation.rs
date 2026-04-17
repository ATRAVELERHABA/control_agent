use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    constants::{
        DEFAULT_LICENSE_PUBLIC_KEY, LICENSE_COPY_FILE_NAME, LICENSE_PRODUCT_ID,
        LICENSE_PUBLIC_KEY_ENV_NAME, LICENSE_SCHEMA_VERSION, LICENSE_STATE_FILE_NAME,
    },
    env::read_env_var,
    licensing::{sha256_base64, verify_key_from_base64, verify_license_document, LicenseDocument},
    logging::timestamp_ms,
    models::{ImportLicenseRequest, ImportLicenseResult, LicenseStatus},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredLicenseState {
    schema_version: u32,
    product_id: String,
    license_id: String,
    account_email: String,
    issued_at: String,
    license_hash: String,
    activated_at: String,
    last_validated_at: String,
}

#[derive(Debug)]
struct ActivationPaths {
    root_dir: PathBuf,
    state_file: PathBuf,
    license_copy_file: PathBuf,
}

#[derive(Debug)]
struct ValidatedLicense {
    license: LicenseDocument,
    app_data_dir: PathBuf,
}

fn activation_paths(app: &AppHandle) -> Result<ActivationPaths, String> {
    let root_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("activation");

    Ok(ActivationPaths {
        state_file: root_dir.join(LICENSE_STATE_FILE_NAME),
        license_copy_file: root_dir.join(LICENSE_COPY_FILE_NAME),
        root_dir,
    })
}

fn configured_public_key() -> String {
    read_env_var(LICENSE_PUBLIC_KEY_ENV_NAME)
        .unwrap_or_else(|| DEFAULT_LICENSE_PUBLIC_KEY.to_string())
}

fn read_license_document(path: &Path) -> Result<(LicenseDocument, String), String> {
    let raw_contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read local license copy: {error}"))?;
    let document = serde_json::from_str::<LicenseDocument>(&raw_contents)
        .map_err(|error| format!("Failed to parse local license copy: {error}"))?;

    Ok((document, raw_contents))
}

fn read_activation_state(path: &Path) -> Result<StoredLicenseState, String> {
    let raw_contents = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read activation state: {error}"))?;

    serde_json::from_str::<StoredLicenseState>(&raw_contents)
        .map_err(|error| format!("Failed to parse activation state: {error}"))
}

fn invalid_license_status(
    app: &AppHandle,
    message: impl Into<String>,
) -> Result<LicenseStatus, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;

    Ok(LicenseStatus {
        valid: false,
        message: message.into(),
        account_email: None,
        license_id: None,
        issued_at: None,
        app_data_dir: app_data_dir.display().to_string(),
    })
}

fn valid_license_status(validated: ValidatedLicense) -> LicenseStatus {
    LicenseStatus {
        valid: true,
        message: "License verified successfully.".to_string(),
        account_email: Some(validated.license.payload.account_email),
        license_id: Some(validated.license.payload.license_id),
        issued_at: Some(validated.license.payload.issued_at),
        app_data_dir: validated.app_data_dir.display().to_string(),
    }
}

fn validate_license(app: &AppHandle) -> Result<ValidatedLicense, String> {
    let paths = activation_paths(app)?;

    if !paths.state_file.exists() || !paths.license_copy_file.exists() {
        return Err("Application is not licensed yet. Please import a license file.".to_string());
    }

    let state = read_activation_state(&paths.state_file)?;
    let (license, raw_license) = read_license_document(&paths.license_copy_file)?;
    let public_key = verify_key_from_base64(&configured_public_key())?;
    verify_license_document(&license, &public_key)?;

    if state.schema_version != LICENSE_SCHEMA_VERSION {
        return Err("Stored license state version is not supported.".to_string());
    }

    if state.product_id != LICENSE_PRODUCT_ID {
        return Err("Stored license state does not belong to this application.".to_string());
    }

    let account_email = license.payload.account_email.trim().to_ascii_lowercase();
    if account_email.is_empty() || !account_email.contains('@') {
        return Err("License account email is missing or invalid.".to_string());
    }

    let license_hash = sha256_base64(raw_license.as_bytes());
    if state.license_id != license.payload.license_id
        || state.account_email != account_email
        || state.license_hash != license_hash
    {
        return Err("Stored license state does not match the local license copy.".to_string());
    }

    Ok(ValidatedLicense {
        license: LicenseDocument {
            payload: crate::licensing::LicensePayload {
                account_email,
                ..license.payload
            },
            signature: license.signature,
        },
        app_data_dir: paths.root_dir,
    })
}

pub(crate) fn ensure_license_valid(app: &AppHandle) -> Result<(), String> {
    validate_license(app).map(|_| ())
}

pub(crate) fn get_license_status(app: &AppHandle) -> Result<LicenseStatus, String> {
    match validate_license(app) {
        Ok(validated) => Ok(valid_license_status(validated)),
        Err(message) => invalid_license_status(app, message),
    }
}

pub(crate) fn import_license(
    app: &AppHandle,
    request: ImportLicenseRequest,
) -> Result<ImportLicenseResult, String> {
    let _ = &request.file_name;
    if request.contents.trim().is_empty() {
        return Err("License file content cannot be empty.".to_string());
    }

    let document = serde_json::from_str::<LicenseDocument>(&request.contents).map_err(|_| {
        "Failed to parse license file. Reissue a v2 account-bound license.".to_string()
    })?;
    let public_key = verify_key_from_base64(&configured_public_key())?;
    verify_license_document(&document, &public_key)?;

    let account_email = document.payload.account_email.trim().to_ascii_lowercase();
    if account_email.is_empty() || !account_email.contains('@') {
        return Err("License account email is missing or invalid.".to_string());
    }

    let paths = activation_paths(app)?;
    fs::create_dir_all(&paths.root_dir)
        .map_err(|error| format!("Failed to create activation directory: {error}"))?;

    let normalized_license = format!(
        "{}\n",
        serde_json::to_string_pretty(&document)
            .map_err(|error| format!("Failed to serialize license file: {error}"))?
    );
    fs::write(&paths.license_copy_file, normalized_license.as_bytes())
        .map_err(|error| format!("Failed to persist local license copy: {error}"))?;

    let now = timestamp_ms().to_string();
    let state = StoredLicenseState {
        schema_version: LICENSE_SCHEMA_VERSION,
        product_id: LICENSE_PRODUCT_ID.to_string(),
        license_id: document.payload.license_id.clone(),
        account_email,
        issued_at: document.payload.issued_at.clone(),
        license_hash: sha256_base64(normalized_license.as_bytes()),
        activated_at: now.clone(),
        last_validated_at: now,
    };
    let serialized_state = format!(
        "{}\n",
        serde_json::to_string_pretty(&state)
            .map_err(|error| format!("Failed to serialize activation state: {error}"))?
    );
    fs::write(&paths.state_file, serialized_state.as_bytes())
        .map_err(|error| format!("Failed to persist activation state: {error}"))?;

    Ok(ImportLicenseResult {
        valid: true,
        status: get_license_status(app)?,
    })
}

pub(crate) fn clear_license(app: &AppHandle) -> Result<LicenseStatus, String> {
    let paths = activation_paths(app)?;

    if paths.root_dir.exists() {
        fs::remove_dir_all(&paths.root_dir)
            .map_err(|error| format!("Failed to clear activation data: {error}"))?;
    }

    invalid_license_status(
        app,
        "License data cleared. Please import a license file again.",
    )
}
