#!/bin/sh
set -eu

INSTALL_ROOT="${TREEPORT_INSTALL_ROOT:-$HOME/.local/lib/treeport}"
BIN_DIR="${TREEPORT_BIN_DIR:-$HOME/.local/bin}"
TREEPORT="$BIN_DIR/treeport"

if [ ! -f "$INSTALL_ROOT/current/install.json" ]; then
  printf 'treeport: no curl-managed installation found at %s\n' "$INSTALL_ROOT" >&2
  exit 1
fi

if [ "${TREEPORT_PURGE:-0}" = '1' ]; then
  "$TREEPORT" up >/dev/null
  "$TREEPORT" down --terminate-terminals --force >/dev/null
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
  "$TREEPORT" down >/dev/null 2>&1 || true
  printf 'Preserved Treeport application data.\n'
fi

rm -f "$TREEPORT"
rm -rf "$INSTALL_ROOT"
printf 'Uninstalled Treeport.\n'
