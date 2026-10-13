// The native owner contains only the authenticated PTY transport and journal.
// Terminal interpretation and product state remain in the TypeScript engine.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("Treeport's session keeper supports macOS and Linux only");

pub mod diagnostics;
pub mod journal;
pub mod owner;
pub mod process;
pub mod protocol;
pub mod pty;
pub mod server;
pub mod storage;
