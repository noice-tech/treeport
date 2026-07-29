#!/bin/sh
set -eu

PACKAGE='@treeport/treeport'
TREEPORT_VERSION="${TREEPORT_VERSION:-0.1.0}"
NODE_VERSION="${TREEPORT_NODE_VERSION:-24.13.0}"
INSTALL_ROOT="${TREEPORT_INSTALL_ROOT:-$HOME/.local/lib/treeport}"
BIN_DIR="${TREEPORT_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf 'treeport: %s\n' "$*" >&2
  exit 1
}

[ "$(uname -s)" = 'Darwin' ] || fail 'the installer currently supports macOS only'
case "$(uname -m)" in
  arm64)
    ARCH='arm64'
    NODE_SHA256='d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8'
    ;;
  x86_64)
    ARCH='x64'
    NODE_SHA256='6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3'
    ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

git --version >/dev/null 2>&1 || fail 'Git is required. Run `xcode-select --install`, finish the installation, and retry.'

tmux_supported() {
  command -v tmux >/dev/null 2>&1 || return 1
  version=$(tmux -V 2>/dev/null | awk '{ print $2 }')
  major=$(printf '%s' "$version" | cut -d. -f1)
  minor=$(printf '%s' "$version" | cut -d. -f2 | sed 's/[^0-9].*$//')
  [ -n "$major" ] && [ -n "$minor" ] &&
    { [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 2 ]; }; }
}

if ! tmux_supported; then
  if ! command -v brew >/dev/null 2>&1; then
    fail 'tmux 3.2 or newer is required. Install tmux, then retry.'
  fi

  install_tmux=${TREEPORT_INSTALL_TMUX:-}
  if [ "$install_tmux" != '1' ]; then
    if [ ! -r /dev/tty ]; then
      fail 'tmux 3.2 or newer is required. Run `brew install tmux`, then retry.'
    fi
    printf 'Treeport requires tmux 3.2 or newer. Install it with Homebrew? [y/N] ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=''
    case "$answer" in
      y|Y|yes|YES) install_tmux='1' ;;
      *) fail 'tmux installation declined' ;;
    esac
  fi

  if [ "$install_tmux" = '1' ]; then
    if brew list tmux >/dev/null 2>&1; then
      brew upgrade tmux
    else
      brew install tmux
    fi
  fi
  tmux_supported || fail 'Homebrew did not install a supported tmux'
fi

mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
work=$(mktemp -d "${TMPDIR:-/tmp}/treeport-install.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
archive="node-v$NODE_VERSION-darwin-$ARCH.tar.gz"
url="${TREEPORT_NODE_BASE_URL:-https://nodejs.org/dist/v$NODE_VERSION}/$archive"
printf 'Downloading Node.js %s for %s...\n' "$NODE_VERSION" "$ARCH"
curl -fL --retry 3 --proto '=https' --tlsv1.2 "$url" -o "$work/$archive"
actual_sha=$(shasum -a 256 "$work/$archive" | awk '{ print $1 }')
[ "$actual_sha" = "${TREEPORT_NODE_SHA256:-$NODE_SHA256}" ] || fail 'Node.js archive checksum did not match'

target="$INSTALL_ROOT/versions/$TREEPORT_VERSION"
stage="$INSTALL_ROOT/versions/.staging-$TREEPORT_VERSION-$$"
rm -rf "$stage"
mkdir -p "$stage/node" "$stage/npm"
tar -xzf "$work/$archive" -C "$stage/node" --strip-components=1

package_spec="${TREEPORT_PACKAGE_SPEC:-$PACKAGE@$TREEPORT_VERSION}"
printf 'Installing %s...\n' "$package_spec"
"$stage/node/bin/node" "$stage/node/bin/npm" install \
  --global \
  --prefix "$stage/npm" \
  --registry "${TREEPORT_NPM_REGISTRY:-https://registry.npmjs.org}" \
  "$package_spec"
"$stage/node/bin/node" \
  "$stage/npm/lib/node_modules/@treeport/treeport/dist/index.js" version >/dev/null

cat >"$stage/install.json" <<EOF
{
  "package": "$PACKAGE",
  "treeportVersion": "$TREEPORT_VERSION",
  "nodeVersion": "$NODE_VERSION",
  "architecture": "$ARCH",
  "installationMethod": "curl",
  "installedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF

was_running='0'
if [ -x "$BIN_DIR/treeport" ] && "$BIN_DIR/treeport" status --json 2>/dev/null | grep -q '"running":true'; then
  was_running='1'
  "$BIN_DIR/treeport" down >/dev/null
fi

rm -rf "$target"
mv "$stage" "$target"

next_link="$INSTALL_ROOT/.current-$$"
ln -s "versions/$TREEPORT_VERSION" "$next_link"
"$target/node/bin/node" -e \
  'const fs=require("node:fs"); try { fs.renameSync(process.argv[1], process.argv[2]) } catch (error) { if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error; fs.rmSync(process.argv[2], { force: true }); fs.renameSync(process.argv[1], process.argv[2]) }' \
  "$next_link" "$INSTALL_ROOT/current"

shim="$BIN_DIR/.treeport-$$"
cat >"$shim" <<EOF
#!/bin/sh
export TREEPORT_INSTALLATION_METHOD=curl
exec "$INSTALL_ROOT/current/node/bin/node" "$INSTALL_ROOT/current/npm/lib/node_modules/@treeport/treeport/dist/index.js" "\$@"
EOF
chmod 755 "$shim"
mv -f "$shim" "$BIN_DIR/treeport"

if [ "$was_running" = '1' ]; then
  "$BIN_DIR/treeport" up >/dev/null
fi

find "$INSTALL_ROOT/versions" -mindepth 1 -maxdepth 1 -type d \
  ! -name "$TREEPORT_VERSION" -exec rm -rf {} +

printf 'Installed Treeport %s\n' "$TREEPORT_VERSION"
case ":$PATH:" in
  *":$BIN_DIR:"*) printf 'Run: treeport up\n' ;;
  *)
    printf 'Add %s to PATH, then run: treeport up\n' "$BIN_DIR"
    printf 'For zsh: echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> "$HOME/.zshrc"\n'
    ;;
esac
