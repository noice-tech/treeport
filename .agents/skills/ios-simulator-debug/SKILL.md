---
name: ios-simulator-debug
description: Debug and validate Treeport in iOS Safari using an iOS Simulator on a local or remote Mac. Use for mobile Safari bugs, touch interactions, text entry, keyboard behavior, screenshots, and simulator UI inspection over SSH or Tailscale.
compatibility: Requires macOS with Xcode and an iOS simulator runtime on the target machine. Remote use requires SSH. Interactive automation requires Node.js 20+, IDB, and an MCP client or runner.
---

# Debug Treeport in iOS Simulator

Edit code in the current worktree; run Safari and simulator automation on a local or remote Mac. Use `ios-simulator-mcp` for screenshots and interactions, and Apple's `xcrun simctl` for device discovery and booting. Native app builds and physical-device testing are outside this workflow.

## 1. Select the target

Use maintainer-provided environment settings, never machine details committed to the repository:

```sh
# On a Mac:
export IOS_SIMULATOR_TARGET=local

# Or an alias already configured in the maintainer's ~/.ssh/config:
export IOS_SIMULATOR_TARGET=ios-debug-mac

# Optional: a simulator selected from discovery, not a shared default UUID:
export IOS_SIMULATOR_UDID='<selected-device-UUID>'
```

These variables are conventions for this skill, not built-in MCP settings. Pass the selected UUID explicitly as `udid` to every simulator tool that accepts it.

If the target is unset, offer local execution on macOS; otherwise ask for an SSH alias. Do not scan a tailnet, guess an account, or select another maintainer's machine. Tailscale is optional: any working SSH connection suffices. Ordinary macOS Remote Login over a Tailscale address does not require Tailscale SSH.

For remote commands use `ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes "$IOS_SIMULATOR_TARGET" ...`. Stop on unknown or changed host keys and ask the maintainer to verify them; never disable host-key checking.

## 2. Read-only preflight

Run on the selected Mac:

```sh
uname -m
sw_vers
xcodebuild -version
xcode-select -p
xcrun simctl list devices available
command -v node npm idb idb_companion
node --version
stat -f %Su /dev/console
```

A noninteractive SSH shell may omit Homebrew and user-local executables. Check a login shell or known installation locations before declaring tools missing. Resolve paths on the target; never assume the local and remote home directories match.

Require Xcode (not only Command Line Tools), an installed iOS runtime, and a usable desktop session. The Mac must remain awake. Initial Xcode setup, licenses, or permission dialogs may need the maintainer's intervention.

Report missing prerequisites and ask before installing packages, downloading runtimes, or changing system settings. Do not upgrade Xcode or macOS as an incidental debugging step.

## 3. Install tooling only with permission

The MCP server wraps two backends:

- Apple's `simctl` for simulator/app management and screenshots.
- Meta's IDB: the Python `fb-idb` client plus a native `idb_companion` for taps, typing, swipes, and accessibility inspection.

Prefer an existing working installation. Pin versions rather than executing an unreviewed latest package on each connection. Check upstream requirements before choosing IDB versions; the current Homebrew formula may require a newer Xcode than the target has.

Verified combination on Apple Silicon, macOS 15.6.1, Xcode 16.4, and iOS 18.6:

| Component | Version |
| --- | --- |
| `ios-simulator-mcp` | 2.1.0 |
| `fb-idb` | 1.1.7 |
| `idb_companion` | 1.1.8 |

This is a verified compatibility combination, not a guarantee for every Mac/runtime. Do not bypass newer packages' requirements. For another environment, check official release compatibility and repeat the smoke check below.

For that verified combination, install in user-local storage on the Mac. With pipx and a compatible Python already available:

```sh
pipx install --python python3.12 fb-idb==1.1.7
root="$HOME/.local/share/ios-simulator-debug"
mkdir -p "$root/idb-companion-1.1.8"
npm install --prefix "$root" ios-simulator-mcp@2.1.0
curl -fL https://github.com/facebook/idb/releases/download/v1.1.8/idb-companion.universal.tar.gz \
  -o "$root/idb-companion-1.1.8.tar.gz"
printf '%s  %s\n' \
  '3b72cc6a9a5b1a22a188205a84090d3a294347a846180efd755cf1a3c848e3e7' \
  "$root/idb-companion-1.1.8.tar.gz" | shasum -a 256 -c -
# Proceed only if checksum verification succeeded:
tar -xzf "$root/idb-companion-1.1.8.tar.gz" -C "$root/idb-companion-1.1.8"
```

The archive contains an extra `idb-companion.universal` directory. Keep its `bin` and `Frameworks` directories together. Do not move only the executable. Avoid modifying shell startup files or global tool installations.

Upstream sources:
- https://github.com/joshuayoes/ios-simulator-mcp
- https://github.com/facebook/idb
- https://github.com/facebook/homebrew-fb/blob/c0386793f59da10c619787f2aa18d938ef1d69c9/idb-companion.rb (historical archive checksum)

## 4. Connect MCP

A skill does not register MCP tools automatically. Use the agent client's supported MCP configuration or an MCP runner. Keep machine-specific registration outside tracked files. Ask before changing persistent agent configuration.

For the user-local installation above, the server launch command **on the Mac** is:

```sh
export PATH="$HOME/.local/bin:$HOME/.local/share/ios-simulator-debug/idb-companion-1.1.8/idb-companion.universal/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export IOS_SIMULATOR_MCP_IDB_PATH="$HOME/.local/bin/idb"
exec node "$HOME/.local/share/ios-simulator-debug/node_modules/ios-simulator-mcp/build/index.js"
```

Adapt executable paths to preflight results, especially if using a different installation. For local execution, run this through a shell. For remote execution, configure the client to launch `ssh -T` with the options above and this shell command as the remote command. Ensure `$HOME` expands on the Mac, not the client machine.

SSH carries MCP stdin/stdout; do not allocate a PTY. Keep stdout free of banners, debug messages, and shell startup output. Diagnostics belong on stderr. Do not expose an MCP HTTP service or IDB port to the network.

Verify MCP initialization and tool discovery before attempting interactions. A custom runner must complete initialization, send `notifications/initialized`, enforce timeouts, and check tool results' `isError`, not just the SSH process exit code. Image content is base64 data with a MIME type, not a local filesystem path.

## 5. Boot and connect Safari to the correct worktree

Select one available simulator and record its UUID. Ask if multiple devices are plausible. Reuse an appropriate running device; do not erase or recreate it. Boot only if shut down:

```sh
xcrun simctl boot "$IOS_SIMULATOR_UDID"
xcrun simctl bootstatus "$IOS_SIMULATOR_UDID" -b
open -a Simulator
```

For Treeport, inspect `apps/treeport/.treeport-dev/runtime/daemon.json` in the **current worktree** and verify its PID belongs to that worktree before targeting its API. Inherited `TREEPORT_*` variables describe the outer instance, which is not necessarily the instance under test. Do not mutate that instance or another worktree's instance without explicit permission. Determine the actual frontend URL from the current development process; do not assume it is the daemon API URL.

Choose a URL reachable from Safari on the Mac:

- Local Mac development: the local development URL.
- Remote development: a tailnet-reachable development URL, or a scoped SSH reverse tunnel from the workstation to a loopback port on the Mac.

`localhost` in this simulator workflow refers to the Mac, not the remote workstation. Check server bindings, allowed hosts, and WebSocket/HMR connectivity. Do not expose a development service publicly or disable authentication to make the test work. HTTP may not support features requiring a secure context; use an appropriate trusted HTTPS setup when testing those features.

Use MCP `open_url` with the selected `udid`. Preserve unrelated browser tabs and simulator sessions.

## 6. Verify before debugging

For first use or a changed toolchain, use a small temporary page with a button and a text input, served from the code-editing machine. Bind it to loopback when tunneling or the intended private interface, not every interface by default.

1. Open the page through MCP.
2. Capture `ui_view` and inspect the returned image.
3. Inspect `ui_describe_all` or `ui_find_element`.
4. Tap the button and confirm a visible state change.
5. Focus the input, call `ui_type` with harmless ASCII text, and confirm the actual input value.
6. Capture the final screenshot. Prefer independent evidence such as page event callbacks in addition to tool success messages.

Known limitations from the verified setup:

- Safari accessibility output contained browser controls but **not webpage elements**. Do not equate this with a missing page element. Use screenshots and coordinate interactions when necessary; MCP is not a DOM, console, or network inspector.
- IDB requires **integer tap coordinates**, although the MCP schema accepts numbers. Round element centers. Coordinates are simulator logical points, not necessarily screenshot pixels; account for screenshot resizing and device scale.
- `ui_type` accepts printable ASCII, not arbitrary Unicode. A successful call does not prove the intended field had focus.
- Software keyboard visibility depends on simulator keyboard settings. Typing alone does not validate keyboard appearance, viewport resizing, or autozoom. Confirm those visually when relevant; ask before changing persistent simulator preferences.
- `ui_view` returns image bytes over MCP. Saved screenshots/videos remain on the Mac and need explicit transfer. Use the returned MIME type for the local file extension.

Do not claim native builds, physical devices, local-only execution, or keyboard behavior were tested unless actually exercised.

## 7. Debug and report

Capture the initial state, reproduce the specific issue, edit code in the current worktree, reload, and repeat the same interaction. Verify an observable behavior change rather than only checking that commands succeeded. If HMR is unavailable, explicitly reload the page.

Report the target mode (local/remote), device model, iOS/Xcode/tool versions, steps exercised, evidence, and limitations. Separate a successful automation smoke check from verification of the actual Treeport bug.

Keep logs, screenshots, recordings, temporary clients, and machine configuration outside tracked files. Review artifacts before publishing: screens and accessibility trees may contain private app data, URLs, or account information. Never include raw SSH configuration, tailnet listings, personal hostnames, addresses, usernames, or device UUIDs in committed examples.

Close only connections and temporary servers/tunnels created for this task. Leave simulator windows and browser tabs available for inspection unless asked to close them. Do not use broad `killall` cleanup or MCP `stop_recording`, which uses broad process termination; do not start recording unless a scoped stop strategy is available. Summarize installed tooling and any processes or settings left changed.
