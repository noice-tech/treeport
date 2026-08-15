#!/bin/sh
set -eu

INSTALL_ROOT="${TREEPORT_INSTALL_ROOT:-$HOME/.local/lib/treeport}"
BIN_DIR="${TREEPORT_BIN_DIR:-$HOME/.local/bin}"
TREEPORT="$BIN_DIR/treeport"

if [ ! -f "$INSTALL_ROOT/current/install.json" ]; then
  printf 'treeport: no curl-managed installation found at %s\n' "$INSTALL_ROOT" >&2
  exit 1
fi

service_status=$("$TREEPORT" service status --json 2>/dev/null || true)
if [ -n "$service_status" ] && ! printf '%s' "$service_status" | grep -q '"state":"disabled"'; then
  if ! "$TREEPORT" service disable; then
    printf 'treeport: complete the administrator action above, then run the uninstaller again.\n' >&2
    exit 1
  fi
  service_status=$("$TREEPORT" service status --json 2>/dev/null || true)
  if [ -n "$service_status" ] && ! printf '%s' "$service_status" | grep -q '"state":"disabled"'; then
    printf 'treeport: service supervision is still installed; refusing to remove package files.\n' >&2
    exit 1
  fi
fi

if "$TREEPORT" --help 2>/dev/null | grep -q '^  start '; then
  start_command='start'
  stop_command='stop'
else
  # The public uninstaller can still remove a curl installation from before
  # the lifecycle command rename.
  start_command='up'
  stop_command='down'
fi

start_treeport() {
  "$TREEPORT" "$start_command" >/dev/null
}

stop_treeport() {
  "$TREEPORT" "$stop_command" "$@" >/dev/null
}

if [ "${TREEPORT_PURGE:-0}" = '1' ]; then
  start_treeport
  stop_treeport --terminate-terminals --force
  if [ -n "${TREEPORT_DATA_DIR:-}" ]; then
    data_dir=$TREEPORT_DATA_DIR
  elif [ -n "${XDG_DATA_HOME:-}" ]; then
    data_dir="$XDG_DATA_HOME/treeport"
  elif [ "$(uname -s)" = 'Darwin' ]; then
    data_dir="$HOME/Library/Application Support/treeport"
  else
    data_dir="$HOME/.local/share/treeport"
  fi

  if [ -n "${TREEPORT_RUNTIME_DIR:-}" ]; then
    runtime_dir=$TREEPORT_RUNTIME_DIR
  elif [ -n "${XDG_RUNTIME_DIR:-}" ]; then
    runtime_dir="$XDG_RUNTIME_DIR/treeport"
  else
    runtime_dir="${TMPDIR:-/tmp}/treeport-$(id -u)"
  fi

  rm -rf "$data_dir" "$runtime_dir"
  printf 'Removed Treeport application data.\n'
else
  stop_treeport || true
  printf 'Preserved Treeport application data.\n'
fi

rm -f "$TREEPORT"
rm -rf "$INSTALL_ROOT"
printf 'Uninstalled Treeport.\n'
