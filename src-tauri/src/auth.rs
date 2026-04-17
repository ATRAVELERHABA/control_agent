use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::{
    activation::{ensure_license_valid, get_license_status},
    constants::{ACCOUNT_STORE_FILE_NAME, AUTH_DIR_NAME, SESSION_STATE_FILE_NAME},
    licensing::sha256_base64,
    logging::timestamp_ms,
    models::{CurrentUser, LicenseStatus, LoginRequest, RegisterAccountRequest, SessionStatus},
};

#[derive(Debug)]
struct AuthPaths {
    root_dir: PathBuf,
    accounts_file: PathBuf,
    session_file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccount {
    email: String,
    password_hash: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoredAccounts {
    accounts: Vec<StoredAccount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredSession {
    email: String,
    logged_in_at: String,
}

fn auth_paths(app: &AppHandle) -> Result<AuthPaths, String> {
    let root_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join(AUTH_DIR_NAME);

    Ok(AuthPaths {
        accounts_file: root_dir.join(ACCOUNT_STORE_FILE_NAME),
        session_file: root_dir.join(SESSION_STATE_FILE_NAME),
        root_dir,
    })
}

fn normalize_email(email: &str) -> Result<String, String> {
    let normalized = email.trim().to_ascii_lowercase();

    if normalized.is_empty() {
        Err("Email cannot be empty.".to_string())
    } else if !normalized.contains('@') {
        Err("Email must be a valid email address.".to_string())
    } else {
        Ok(normalized)
    }
}

fn validate_password(password: &str) -> Result<String, String> {
    let trimmed = password.trim().to_string();

    if trimmed.len() < 6 {
        Err("Password must be at least 6 characters long.".to_string())
    } else {
        Ok(trimmed)
    }
}

fn password_hash(email: &str, password: &str) -> String {
    sha256_base64(format!("local-auth::{email}::{password}").as_bytes())
}

fn read_accounts(path: &PathBuf) -> Result<StoredAccounts, String> {
    if !path.exists() {
        return Ok(StoredAccounts::default());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read local account store: {error}"))?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse local account store: {error}"))
}

fn write_accounts(path: &PathBuf, payload: &StoredAccounts) -> Result<(), String> {
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(payload)
            .map_err(|error| format!("Failed to serialize local account store: {error}"))?
    );
    fs::write(path, serialized)
        .map_err(|error| format!("Failed to persist local account store: {error}"))
}

fn read_session(path: &PathBuf) -> Result<Option<StoredSession>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read local session: {error}"))?;
    let session = serde_json::from_str(&raw)
        .map_err(|error| format!("Failed to parse local session: {error}"))?;
    Ok(Some(session))
}

fn write_session(path: &PathBuf, session: &StoredSession) -> Result<(), String> {
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(session)
            .map_err(|error| format!("Failed to serialize local session: {error}"))?
    );
    fs::write(path, serialized).map_err(|error| format!("Failed to persist local session: {error}"))
}

pub(crate) fn get_session_status(app: &AppHandle) -> Result<SessionStatus, String> {
    let license_status = get_license_status(app)?;
    if !license_status.valid {
        return Ok(SessionStatus {
            authenticated: false,
            message: "A valid license is required before logging in.".to_string(),
            email: None,
        });
    }

    let paths = auth_paths(app)?;
    let Some(session) = read_session(&paths.session_file)? else {
        return Ok(SessionStatus {
            authenticated: false,
            message: "Not logged in.".to_string(),
            email: None,
        });
    };

    let accounts = read_accounts(&paths.accounts_file)?;
    if !accounts
        .accounts
        .iter()
        .any(|account| account.email == session.email)
    {
        return Ok(SessionStatus {
            authenticated: false,
            message: "Stored session does not match any local account.".to_string(),
            email: None,
        });
    }

    if license_status.account_email.as_deref() != Some(session.email.as_str()) {
        return Ok(SessionStatus {
            authenticated: false,
            message: "Stored session does not match the licensed account.".to_string(),
            email: None,
        });
    }

    Ok(SessionStatus {
        authenticated: true,
        message: "Logged in.".to_string(),
        email: Some(session.email),
    })
}

pub(crate) fn register_account(
    app: &AppHandle,
    request: RegisterAccountRequest,
) -> Result<SessionStatus, String> {
    let email = normalize_email(&request.email)?;
    let password = validate_password(&request.password)?;
    let paths = auth_paths(app)?;
    fs::create_dir_all(&paths.root_dir)
        .map_err(|error| format!("Failed to create auth directory: {error}"))?;

    let mut accounts = read_accounts(&paths.accounts_file)?;
    if accounts
        .accounts
        .iter()
        .any(|account| account.email == email)
    {
        return Err("An account with this email already exists.".to_string());
    }

    accounts.accounts.push(StoredAccount {
        email: email.clone(),
        password_hash: password_hash(&email, &password),
        created_at: timestamp_ms().to_string(),
    });
    write_accounts(&paths.accounts_file, &accounts)?;

    Ok(SessionStatus {
        authenticated: false,
        message: "Registration succeeded. Please log in with the licensed account.".to_string(),
        email: Some(email),
    })
}

pub(crate) fn login(app: &AppHandle, request: LoginRequest) -> Result<SessionStatus, String> {
    let license_status: LicenseStatus = get_license_status(app)?;
    if !license_status.valid {
        return Err("A valid license is required before logging in.".to_string());
    }

    let email = normalize_email(&request.email)?;
    let password = validate_password(&request.password)?;
    let paths = auth_paths(app)?;
    fs::create_dir_all(&paths.root_dir)
        .map_err(|error| format!("Failed to create auth directory: {error}"))?;

    let accounts = read_accounts(&paths.accounts_file)?;
    let account = accounts
        .accounts
        .iter()
        .find(|account| account.email == email)
        .ok_or_else(|| "Account not found.".to_string())?;

    if account.password_hash != password_hash(&email, &password) {
        return Err("Invalid email or password.".to_string());
    }

    if license_status.account_email.as_deref() != Some(email.as_str()) {
        return Err("This license does not belong to the provided account.".to_string());
    }

    write_session(
        &paths.session_file,
        &StoredSession {
            email: email.clone(),
            logged_in_at: timestamp_ms().to_string(),
        },
    )?;

    Ok(SessionStatus {
        authenticated: true,
        message: "Login succeeded.".to_string(),
        email: Some(email),
    })
}

pub(crate) fn logout(app: &AppHandle) -> Result<SessionStatus, String> {
    clear_session(app)?;
    Ok(SessionStatus {
        authenticated: false,
        message: "Logged out.".to_string(),
        email: None,
    })
}

pub(crate) fn clear_session(app: &AppHandle) -> Result<(), String> {
    let paths = auth_paths(app)?;
    if paths.session_file.exists() {
        fs::remove_file(&paths.session_file)
            .map_err(|error| format!("Failed to clear local session: {error}"))?;
    }
    Ok(())
}

pub(crate) fn ensure_authenticated(app: &AppHandle) -> Result<CurrentUser, String> {
    ensure_license_valid(app)?;
    let status = get_session_status(app)?;
    if !status.authenticated {
        return Err(status.message);
    }

    let email = status
        .email
        .ok_or_else(|| "Authenticated session is missing an email.".to_string())?;

    Ok(CurrentUser { email })
}

pub(crate) fn get_current_user(app: &AppHandle) -> Result<CurrentUser, String> {
    ensure_authenticated(app)
}
