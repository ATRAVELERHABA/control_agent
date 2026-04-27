#!/usr/bin/env sh

set -eu

OUTPUT_ROOT="${1:-src-tauri/bundled-resources}"

log_warning() {
  printf '%s\n' "Warning: $1" >&2
}

copy_dir() {
  source_dir="$1"
  destination_dir="$2"

  if [ ! -d "$source_dir" ]; then
    log_warning "Skip missing directory: $source_dir"
    return 0
  fi

  rm -rf "$destination_dir"
  mkdir -p "$(dirname "$destination_dir")"
  cp -a "$source_dir" "$destination_dir"
}

copy_file() {
  source_file="$1"
  destination_file="$2"

  if [ ! -f "$source_file" ]; then
    log_warning "Skip missing file: $source_file"
    return 0
  fi

  mkdir -p "$(dirname "$destination_file")"
  cp "$source_file" "$destination_file"
}

resolve_dir() {
  candidate="$1"

  if [ -n "$candidate" ] && [ -d "$candidate" ]; then
    (
      cd "$candidate"
      pwd -P
    )
    return 0
  fi

  return 1
}

find_site_packages_dir() {
  venv_lib_dir="$1"

  if [ ! -d "$venv_lib_dir" ]; then
    return 1
  fi

  find "$venv_lib_dir" -maxdepth 2 -type d -name site-packages | head -n 1
}

SCRIPT_DIR=$(
  CDPATH= cd -- "$(dirname -- "$0")"
  pwd -P
)
REPO_ROOT=$(
  CDPATH= cd -- "$SCRIPT_DIR/.."
  pwd -P
)
BUNDLE_ROOT="$REPO_ROOT/$OUTPUT_ROOT"

SKILLS_SOURCE="$REPO_ROOT/.skills"
SCRIPTS_SOURCE="$REPO_ROOT/control_agent/scripts"
ENV_EXAMPLE_SOURCE="$REPO_ROOT/.env.example"
VENV_LIB_DIR="$REPO_ROOT/control_agent/.venv/lib"

mkdir -p "$BUNDLE_ROOT"

copy_dir "$SKILLS_SOURCE" "$BUNDLE_ROOT/.skills"
copy_dir "$SCRIPTS_SOURCE" "$BUNDLE_ROOT/control_agent/scripts"
copy_file "$ENV_EXAMPLE_SOURCE" "$BUNDLE_ROOT/.env.example"

SITE_PACKAGES_SOURCE="$(find_site_packages_dir "$VENV_LIB_DIR" || true)"
if [ -n "$SITE_PACKAGES_SOURCE" ]; then
  copy_dir "$SITE_PACKAGES_SOURCE" "$BUNDLE_ROOT/control_agent/site-packages"
else
  log_warning "Skip missing Linux site-packages under $VENV_LIB_DIR"
fi

PYTHON_HOME="${EMBEDDED_PYTHON_HOME:-}"
if [ -z "$PYTHON_HOME" ]; then
  PYTHON_HOME="${LINUX_EMBEDDED_PYTHON_HOME:-}"
fi

RESOLVED_PYTHON_HOME="$(resolve_dir "$PYTHON_HOME" || true)"
if [ -n "$RESOLVED_PYTHON_HOME" ]; then
  copy_dir "$RESOLVED_PYTHON_HOME" "$BUNDLE_ROOT/python-runtime"
else
  log_warning "Embedded Python home was not found. Linux bundles will rely on a system Python installation unless EMBEDDED_PYTHON_HOME or LINUX_EMBEDDED_PYTHON_HOME is set."
fi

printf '%s\n' "Bundled resources prepared at $BUNDLE_ROOT"
