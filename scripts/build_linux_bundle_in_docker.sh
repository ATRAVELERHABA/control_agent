#!/usr/bin/env sh

set -eu

SCRIPT_DIR=$(
  CDPATH= cd -- "$(dirname -- "$0")"
  pwd -P
)
REPO_ROOT=$(
  CDPATH= cd -- "$SCRIPT_DIR/.."
  pwd -P
)
OUTPUT_DIR="$REPO_ROOT/.tmp/linux-bundle"
APT_ARCHIVES_DIR="$REPO_ROOT/.tmp/docker-apt/archives"

mkdir -p "$OUTPUT_DIR"
mkdir -p "$APT_ARCHIVES_DIR"

printf '%s\n' "Starting Linux bundle build in Docker..."

docker run --rm \
  --entrypoint bash \
  -e http_proxy= \
  -e https_proxy= \
  -e HTTP_PROXY= \
  -e HTTPS_PROXY= \
  -e ALL_PROXY= \
  -e all_proxy= \
  -e no_proxy= \
  -e NO_PROXY= \
  -v "$REPO_ROOT:/work" \
  -v "$APT_ARCHIVES_DIR:/var/cache/apt/archives" \
  -v "$HOME/.nvm:/wsl-home/.nvm" \
  -v "$HOME/.cargo:/wsl-home/.cargo" \
  -v "$HOME/.rustup:/wsl-home/.rustup" \
  postgres:latest \
  -lc '
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy no_proxy NO_PROXY
cat > /etc/apt/apt.conf.d/99no-proxy <<EOF
Acquire::http::Proxy "false";
Acquire::https::Proxy "false";
EOF
. /etc/os-release
rm -f /etc/apt/sources.list.d/*
cat > /etc/apt/sources.list <<EOF
deb http://mirrors.tuna.tsinghua.edu.cn/debian/ ${VERSION_CODENAME} main
deb http://mirrors.tuna.tsinghua.edu.cn/debian/ ${VERSION_CODENAME}-updates main
deb http://mirrors.tuna.tsinghua.edu.cn/debian-security ${VERSION_CODENAME}-security main
EOF
echo "[1/5] Updating apt indexes..."
apt-get -o Acquire::Retries=10 update
echo "[2/5] Downloading Linux build dependencies..."
apt-get -o Acquire::Retries=10 -o APT::Keep-Downloaded-Packages=true install -y --download-only --fix-missing --no-install-recommends \
  ca-certificates \
  file \
  build-essential \
  pkg-config \
  patchelf \
  desktop-file-utils \
  libssl-dev \
  libxdo-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev \
  libgtk-3-dev \
  libglib2.0-dev \
  xz-utils
echo "[3/5] Installing Linux build dependencies..."
apt-get -o Acquire::Retries=10 -o APT::Keep-Downloaded-Packages=true install -y --fix-missing --no-install-recommends \
  ca-certificates \
  file \
  build-essential \
  pkg-config \
  patchelf \
  desktop-file-utils \
  libssl-dev \
  libxdo-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  libjavascriptcoregtk-4.1-dev \
  libgtk-3-dev \
  libglib2.0-dev \
  xz-utils
export NVM_DIR=/wsl-home/.nvm
export CARGO_HOME=/wsl-home/.cargo
export RUSTUP_HOME=/wsl-home/.rustup
. "$NVM_DIR/nvm.sh"
nvm use default
export PATH="$CARGO_HOME/bin:$PATH"
echo "[4/5] Copying project into container workspace..."
rm -rf /tmp/build
mkdir -p /tmp/build
cd /work
tar \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=src-tauri/target \
  --exclude=license_tool/target \
  --exclude=.tmp \
  -cf - . | tar -xf - -C /tmp/build
cd /tmp/build
npm install
echo "[5/5] Building Tauri Linux bundles..."
npm run tauri:build:linux
mkdir -p /work/.tmp/linux-bundle
rm -rf /work/.tmp/linux-bundle/*
cp -a /tmp/build/src-tauri/target/release/bundle/. /work/.tmp/linux-bundle/
'

printf '%s\n' "Linux bundles copied to $OUTPUT_DIR"
