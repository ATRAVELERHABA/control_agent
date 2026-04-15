# license_tool

A small cross-platform CLI to issue offline license files for the desktop app.

## Build & run

- Generate a keypair:

```bash
cargo run --release --manifest-path license_tool/Cargo.toml -- gen-keypair
```

- Issue a license (requires private key):

```bash
# Option A: env var
$env:LICENSE_PRIVATE_KEY = "<private_key_base64url_no_pad>"

cargo run --release --manifest-path license_tool/Cargo.toml -- issue \
  --email "demo@example.com" \
  --out "./demo-license.json"
```

The output file is a JSON document with an account-bound payload and an Ed25519 signature.
