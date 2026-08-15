#!/bin/sh
set -eu

PACKAGE='@treeport/treeport'
TREEPORT_VERSION="${TREEPORT_VERSION:-0.3.0}"
MINIMUM_NODE_MAJOR=24
INSTALL_ROOT="${TREEPORT_INSTALL_ROOT:-$HOME/.local/lib/treeport}"
BIN_DIR="${TREEPORT_BIN_DIR:-$HOME/.local/bin}"

fail() {
  printf 'treeport: %s\n' "$*" >&2
  exit 1
}

operating_system=$(uname -s)
case "$operating_system" in
  Darwin|Linux) ;;
  *) fail "the installer supports macOS and Linux; found $operating_system" ;;
esac

git --version >/dev/null 2>&1 || fail 'Git is required. Install Git with your preferred package manager, then retry.'

command -v node >/dev/null 2>&1 || fail 'Node.js 24 or newer is required. Install Node.js with your preferred package manager, then retry.'
node_version=$(node --version 2>/dev/null || true)
node_major=${node_version#v}
node_major=${node_major%%.*}
case "$node_major" in
  ''|*[!0-9]*)
    fail "Node.js 24 or newer is required; found ${node_version:-an unreadable version}. Upgrade Node.js, then retry."
    ;;
esac
[ "$node_major" -ge "$MINIMUM_NODE_MAJOR" ] ||
  fail "Node.js 24 or newer is required; found $node_version. Upgrade Node.js, then retry."
node_executable=$(node -p 'process.execPath' 2>/dev/null || true)
case "$node_executable" in
  /*) [ -x "$node_executable" ] || fail "Node.js is not executable at $node_executable" ;;
  *) fail 'Could not resolve the absolute Node.js executable path.' ;;
esac
command -v npm >/dev/null 2>&1 || fail 'npm is required. Install npm for your Node.js installation, then retry.'

tmux_supported() {
  command -v tmux >/dev/null 2>&1 || return 1
  version=$(tmux -V 2>/dev/null | awk '{ print $2 }')
  major=$(printf '%s' "$version" | cut -d. -f1)
  minor=$(printf '%s' "$version" | cut -d. -f2 | sed 's/[^0-9].*$//')
  [ -n "$major" ] && [ -n "$minor" ] &&
    { [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 2 ]; }; }
}

if ! tmux_supported; then
  tmux_manager=''
  tmux_manager_name=''
  if command -v brew >/dev/null 2>&1; then
    tmux_manager='brew'
    tmux_manager_name='Homebrew'
  elif command -v port >/dev/null 2>&1; then
    tmux_manager='port'
    tmux_manager_name='MacPorts'
  elif command -v apt-get >/dev/null 2>&1; then
    tmux_manager='apt-get'
    tmux_manager_name='APT'
  elif command -v dnf >/dev/null 2>&1; then
    tmux_manager='dnf'
    tmux_manager_name='DNF'
  elif command -v yum >/dev/null 2>&1; then
    tmux_manager='yum'
    tmux_manager_name='YUM'
  elif command -v pacman >/dev/null 2>&1; then
    tmux_manager='pacman'
    tmux_manager_name='pacman'
  elif command -v zypper >/dev/null 2>&1; then
    tmux_manager='zypper'
    tmux_manager_name='Zypper'
  elif command -v apk >/dev/null 2>&1; then
    tmux_manager='apk'
    tmux_manager_name='apk'
  fi
  if [ -z "$tmux_manager" ]; then
    fail 'tmux 3.2 or newer is required. Install it with your preferred package manager, then retry. See https://github.com/tmux/tmux/wiki/Installing.'
  fi

  install_tmux=${TREEPORT_INSTALL_TMUX:-}
  if [ "$install_tmux" != '1' ]; then
    if [ ! -r /dev/tty ] || ! (: </dev/tty) 2>/dev/null; then
      fail "tmux 3.2 or newer is required. Install it with $tmux_manager_name, then retry."
    fi
    printf 'Treeport requires tmux 3.2 or newer. Install it with %s? [y/N] ' "$tmux_manager_name" >/dev/tty
    IFS= read -r answer </dev/tty || answer=''
    case "$answer" in
      y|Y|yes|YES) install_tmux='1' ;;
      *) fail 'tmux installation declined' ;;
    esac
  fi

  run_privileged() {
    if [ "$(id -u)" -eq 0 ]; then
      "$@"
    elif command -v sudo >/dev/null 2>&1; then
      sudo "$@"
    elif command -v doas >/dev/null 2>&1; then
      doas "$@"
    else
      fail "$tmux_manager_name requires root privileges. Install tmux 3.2 or newer, then retry."
    fi
  }

  case "$tmux_manager" in
    brew)
      if brew list tmux >/dev/null 2>&1; then
        brew upgrade tmux
      else
        brew install tmux
      fi
      ;;
    port)
      if port installed tmux 2>/dev/null | grep -q '(active)'; then
        run_privileged port upgrade tmux
      else
        run_privileged port install tmux
      fi
      ;;
    apt-get) run_privileged apt-get install -y tmux ;;
    dnf) run_privileged dnf install -y tmux ;;
    yum) run_privileged yum install -y tmux ;;
    pacman) run_privileged pacman -S --needed --noconfirm tmux ;;
    zypper) run_privileged zypper --non-interactive install tmux ;;
    apk) run_privileged apk add tmux ;;
  esac
  tmux_supported || fail "$tmux_manager_name did not install a supported tmux"
fi

mkdir -p "$INSTALL_ROOT/versions" "$BIN_DIR"
target="$INSTALL_ROOT/versions/$TREEPORT_VERSION"
stage="$INSTALL_ROOT/versions/.staging-$TREEPORT_VERSION-$$"
rm -rf "$stage"
mkdir -p "$stage/npm"
trap 'rm -rf "$stage"' EXIT HUP INT TERM

package_spec="${TREEPORT_PACKAGE_SPEC:-$PACKAGE@$TREEPORT_VERSION}"
printf 'Installing %s...\n' "$package_spec"
npm install \
  --global \
  --prefix "$stage/npm" \
  --registry "${TREEPORT_NPM_REGISTRY:-https://registry.npmjs.org}" \
  "$package_spec"
node "$stage/npm/lib/node_modules/@treeport/treeport/dist/node/cli/index.js" version >/dev/null

cat >"$stage/install.json" <<EOF
{
  "package": "$PACKAGE",
  "treeportVersion": "$TREEPORT_VERSION",
  "installationMethod": "curl",
  "installedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF

was_running='0'
if [ -x "$BIN_DIR/treeport" ] && "$BIN_DIR/treeport" status --json 2>/dev/null | grep -q '"running":true'; then
  was_running='1'
  if "$BIN_DIR/treeport" --help 2>/dev/null | grep -q '^  start '; then
    if ! "$BIN_DIR/treeport" stop; then
      fail 'Treeport did not stop. Complete any service administrator action above, then rerun the installer.'
    fi
  else
    # Treeport 0.2.2 used the old name. This fallback exists only in the
    # installer that performs the package cutover.
    "$BIN_DIR/treeport" down >/dev/null
  fi
fi

rm -rf "$target"
mv "$stage" "$target"

next_link="$INSTALL_ROOT/.current-$$"
ln -s "versions/$TREEPORT_VERSION" "$next_link"
node -e \
  'const fs=require("node:fs"); try { fs.renameSync(process.argv[1], process.argv[2]) } catch (error) { if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error; fs.rmSync(process.argv[2], { force: true }); fs.renameSync(process.argv[1], process.argv[2]) }' \
  "$next_link" "$INSTALL_ROOT/current"

shim="$BIN_DIR/.treeport-$$"
node_executable_for_shim=$(printf '%s' "$node_executable" | sed "s/'/'\\\\''/g")
cat >"$shim" <<EOF
#!/bin/sh
export TREEPORT_INSTALLATION_METHOD=curl
export TREEPORT_CLI_ENTRYPOINT="$BIN_DIR/treeport"
exec '$node_executable_for_shim' "$INSTALL_ROOT/current/npm/lib/node_modules/@treeport/treeport/dist/node/cli/index.js" "\$@"
EOF
chmod 755 "$shim"
mv -f "$shim" "$BIN_DIR/treeport"

if [ "$was_running" = '1' ]; then
  "$BIN_DIR/treeport" start >/dev/null
fi

find "$INSTALL_ROOT/versions" -mindepth 1 -maxdepth 1 -type d \
  ! -name "$TREEPORT_VERSION" -exec rm -rf {} +

printf 'Installed Treeport %s\n' "$TREEPORT_VERSION"
case ":$PATH:" in
  *":$BIN_DIR:"*) printf 'Run: treeport start\n' ;;
  *)
    printf 'Add %s to PATH, then run: treeport start\n' "$BIN_DIR"
    printf 'For zsh: echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> "$HOME/.zshrc"\n'
    ;;
esac
