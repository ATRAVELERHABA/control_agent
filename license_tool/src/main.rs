use std::{
    env,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signer, SigningKey};
use rand::rngs::OsRng;
use serde::Serialize;

const DEFAULT_SCHEMA_VERSION: u32 = 1;
const DEFAULT_PRODUCT_ID: &str = "com.aiuniversalassistant.app";

/// Optional dev-only fallback. Leave empty if you prefer supplying private key via env/args.
const DEFAULT_PRIVATE_KEY_BASE64: &str = "fqI9-1akoIElmcTEbWnBKxyLakENFhq0sXkNVgSLO0g";

const PRIVATE_KEY_ENV: &str = "LICENSE_PRIVATE_KEY";

#[derive(Debug, Parser)]
#[command(name = "license_tool")]
#[command(about = "Offline license issuer CLI", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Generate a new Ed25519 keypair.
    GenKeypair {
        /// Optional output file path. If omitted, prints JSON to stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },

    /// Issue a signed JSON license file.
    Issue {
        /// Licensed account email.
        #[arg(long)]
        email: String,

        /// Output license file path.
        #[arg(long)]
        out: PathBuf,

        /// Private key in base64url (no padding). Overrides env var LICENSE_PRIVATE_KEY.
        #[arg(long)]
        private_key: Option<String>,

        /// Read private key from a file (base64url text).
        #[arg(long)]
        private_key_file: Option<PathBuf>,
    },
}

#[derive(Debug, Serialize)]
struct GeneratedKeyPair {
    public_key: String,
    private_key: String,
}

#[derive(Debug, Clone, Serialize)]
struct LicensePayload {
    schema_version: u32,
    product_id: String,
    license_id: String,
    issued_at: String,
    account_email: String,
}

#[derive(Debug, Clone, Serialize)]
struct LicenseDocument {
    #[serde(flatten)]
    payload: LicensePayload,
    signature: String,
}

fn current_unix_timestamp() -> Result<String, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .map_err(|_| "Failed to get current time.".to_string())
}

fn sanitize_non_empty(value: &str, field: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(format!("{field} cannot be empty."))
    } else {
        Ok(trimmed.to_string())
    }
}

fn signing_key_from_base64(base64_text: &str) -> Result<SigningKey, String> {
    let raw = URL_SAFE_NO_PAD
        .decode(base64_text.trim())
        .map_err(|error| format!("Failed to decode private key: {error}"))?;

    let raw: [u8; 32] = raw
        .try_into()
        .map_err(|_| "Private key must contain exactly 32 bytes.".to_string())?;

    Ok(SigningKey::from_bytes(&raw))
}

fn payload_bytes(payload: &LicensePayload) -> Result<Vec<u8>, String> {
    serde_json::to_vec(payload).map_err(|error| format!("Failed to serialize payload: {error}"))
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create output directory: {error}"))?;
        }
    }
    Ok(())
}

fn read_private_key_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path)
        .map_err(|error| format!("Failed to read private key file: {error}"))
        .map(|text| text.trim().to_string())
}

fn resolve_private_key_base64(
    private_key: Option<String>,
    private_key_file: Option<PathBuf>,
) -> Result<String, String> {
    if let Some(value) = private_key {
        return Ok(value.trim().to_string());
    }

    if let Some(path) = private_key_file {
        let text = read_private_key_text(&path)?;
        if text.is_empty() {
            return Err("Private key file is empty.".to_string());
        }
        return Ok(text);
    }

    if let Ok(value) = env::var(PRIVATE_KEY_ENV) {
        let trimmed = value.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }

    if !DEFAULT_PRIVATE_KEY_BASE64.trim().is_empty() {
        return Ok(DEFAULT_PRIVATE_KEY_BASE64.trim().to_string());
    }

    Err(format!(
        "Missing private key. Provide --private-key, --private-key-file, or set env {PRIVATE_KEY_ENV}."
    ))
}

fn cmd_gen_keypair(out: Option<PathBuf>) -> Result<(), String> {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();

    let pair = GeneratedKeyPair {
        public_key: URL_SAFE_NO_PAD.encode(verifying_key.to_bytes()),
        private_key: URL_SAFE_NO_PAD.encode(signing_key.to_bytes()),
    };

    let serialized = serde_json::to_string_pretty(&pair)
        .map_err(|error| format!("Failed to serialize keypair: {error}"))?;

    match out {
        Some(path) => {
            ensure_parent_dir(&path)?;
            fs::write(&path, format!("{serialized}\n").as_bytes())
                .map_err(|error| format!("Failed to write keypair file: {error}"))?;
            println!("Keypair written to {}", path.display());
        }
        None => {
            println!("{serialized}");
        }
    }

    Ok(())
}

fn cmd_issue(
    email: String,
    out: PathBuf,
    private_key: Option<String>,
    private_key_file: Option<PathBuf>,
) -> Result<(), String> {
    let account_email = sanitize_non_empty(&email, "email")?.to_ascii_lowercase();
    if !account_email.contains('@') {
        return Err("email must be a valid email address.".to_string());
    }
    let private_key_base64 = resolve_private_key_base64(private_key, private_key_file)?;

    let issued_at = current_unix_timestamp()?;
    let payload = LicensePayload {
        schema_version: DEFAULT_SCHEMA_VERSION,
        product_id: DEFAULT_PRODUCT_ID.to_string(),
        license_id: format!("lic-{issued_at}"),
        issued_at,
        account_email,
    };

    let signing_key = signing_key_from_base64(&private_key_base64)?;
    let signature = signing_key.sign(&payload_bytes(&payload)?);

    let document = LicenseDocument {
        payload,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    };

    let serialized = serde_json::to_string_pretty(&document)
        .map_err(|error| format!("Failed to serialize license: {error}"))?;

    ensure_parent_dir(&out)?;
    fs::write(&out, format!("{serialized}\n").as_bytes())
        .map_err(|error| format!("Failed to write license file: {error}"))?;

    println!("License written to {}", out.display());
    Ok(())
}

fn run() -> Result<(), String> {
    let cli = Cli::parse();

    match cli.command {
        Command::GenKeypair { out } => cmd_gen_keypair(out),
        Command::Issue {
            email,
            out,
            private_key,
            private_key_file,
        } => cmd_issue(email, out, private_key, private_key_file),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Error: {error}");
        std::process::exit(1);
    }
}
