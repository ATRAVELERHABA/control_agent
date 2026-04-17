use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::constants::{LICENSE_PRODUCT_ID, LICENSE_SCHEMA_VERSION};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicensePayload {
    pub schema_version: u32,
    pub product_id: String,
    pub license_id: String,
    pub issued_at: String,
    pub account_email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LicenseDocument {
    #[serde(flatten)]
    pub payload: LicensePayload,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GeneratedKeyPair {
    pub public_key: String,
    pub private_key: String,
}

fn current_unix_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn sanitize_account_email(account_email: &str) -> Result<String, String> {
    let trimmed = account_email.trim().to_ascii_lowercase();

    if trimmed.is_empty() {
        Err("License account email cannot be empty.".to_string())
    } else if !trimmed.contains('@') {
        Err("License account email must be a valid email address.".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}

pub fn payload_bytes(payload: &LicensePayload) -> Result<Vec<u8>, String> {
    serde_json::to_vec(payload)
        .map_err(|error| format!("Failed to serialize license payload: {error}"))
}

pub fn sha256_base64(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    URL_SAFE_NO_PAD.encode(digest)
}

pub fn verify_key_from_base64(base64_text: &str) -> Result<VerifyingKey, String> {
    let raw = URL_SAFE_NO_PAD
        .decode(base64_text.trim())
        .map_err(|error| format!("Failed to decode public key: {error}"))?;
    let raw: [u8; 32] = raw
        .try_into()
        .map_err(|_| "Public key must contain exactly 32 bytes.".to_string())?;

    VerifyingKey::from_bytes(&raw).map_err(|error| format!("Invalid public key: {error}"))
}

pub fn signing_key_from_base64(base64_text: &str) -> Result<SigningKey, String> {
    let raw = URL_SAFE_NO_PAD
        .decode(base64_text.trim())
        .map_err(|error| format!("Failed to decode private key: {error}"))?;
    let raw: [u8; 32] = raw
        .try_into()
        .map_err(|_| "Private key must contain exactly 32 bytes.".to_string())?;

    Ok(SigningKey::from_bytes(&raw))
}

pub fn generate_keypair() -> GeneratedKeyPair {
    let signing_key = SigningKey::generate(&mut OsRng);
    let verifying_key = signing_key.verifying_key();

    GeneratedKeyPair {
        public_key: URL_SAFE_NO_PAD.encode(verifying_key.to_bytes()),
        private_key: URL_SAFE_NO_PAD.encode(signing_key.to_bytes()),
    }
}

pub fn issue_license(
    account_email: &str,
    private_key_base64: &str,
) -> Result<LicenseDocument, String> {
    let account_email = sanitize_account_email(account_email)?;
    let signing_key = signing_key_from_base64(private_key_base64)?;
    let payload = LicensePayload {
        schema_version: LICENSE_SCHEMA_VERSION,
        product_id: LICENSE_PRODUCT_ID.to_string(),
        license_id: format!("lic-{}", current_unix_timestamp()),
        issued_at: current_unix_timestamp(),
        account_email,
    };
    let signature = signing_key.sign(&payload_bytes(&payload)?);

    Ok(LicenseDocument {
        payload,
        signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    })
}

pub fn verify_license_document(
    document: &LicenseDocument,
    public_key: &VerifyingKey,
) -> Result<(), String> {
    if document.payload.schema_version != LICENSE_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported license schema version: {}",
            document.payload.schema_version
        ));
    }

    if document.payload.product_id != LICENSE_PRODUCT_ID {
        return Err(format!(
            "License product mismatch: {}",
            document.payload.product_id
        ));
    }

    let signature_bytes = URL_SAFE_NO_PAD
        .decode(document.signature.trim())
        .map_err(|error| format!("Failed to decode signature: {error}"))?;
    let signature_bytes: [u8; 64] = signature_bytes
        .try_into()
        .map_err(|_| "Signature must contain exactly 64 bytes.".to_string())?;
    let signature = Signature::from_bytes(&signature_bytes);

    public_key
        .verify(&payload_bytes(&document.payload)?, &signature)
        .map_err(|error| format!("Signature verification failed: {error}"))
}
