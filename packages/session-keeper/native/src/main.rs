use anyhow::{bail, Context, Result};
use std::{
    fs::{self, OpenOptions},
    io,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        process::CommandExt,
    },
    path::PathBuf,
};
use treeport_session_keeper::{
    journal::{open_regular, Journal},
    owner::Handle,
    protocol::{Manifest, MAX_MANIFEST_BYTES},
    pty::Pty,
    server,
    storage::Storage,
};

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let first = args.next().context("Missing session directory")?;
    if first == "--version" {
        if args.next().is_some() {
            bail!("Unexpected version arguments");
        }
        println!(
            "treeport-session-keeper {} protocol=1",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if first == "--detach" {
        let directory = args.next().context("Missing session directory")?;
        let mut command = std::process::Command::new(std::env::current_exe()?);
        command.arg(directory);
        // Treeport supplies argv[0] as an opaque display title. Preserve it in
        // the detached owner without interpreting product metadata or labels.
        command.arg0(
            std::env::args_os()
                .next()
                .context("Missing process title")?,
        );
        // SAFETY: pre_exec calls only the async-signal-safe setsid syscall.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        command.spawn()?;
        return Ok(());
    }
    if args.next().is_some() {
        bail!("Unexpected session keeper arguments");
    }
    let directory = PathBuf::from(first);
    let metadata = fs::symlink_metadata(&directory)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        bail!("Session directory must be private and owned by the current user");
    }
    let manifest_file = open_regular(
        &directory.join("manifest.json"),
        OpenOptions::new().read(true),
    )?;
    // Reject known oversized files without reading/allocating their contents.
    // Manifest::read also caps actual bytes if this descriptor grows afterward.
    if manifest_file.metadata()?.len() > MAX_MANIFEST_BYTES as u64 {
        bail!("Session manifest exceeds the byte limit");
    }
    let manifest = Manifest::read(manifest_file)?;
    #[cfg(target_os = "linux")]
    {
        // Refuse an unclosable opt-in session BEFORE creating its journal or
        // command. pidfd signaling needs Linux >=5.3 and a permitting seccomp
        // policy; never silently downgrade identity safety on older kernels.
        let own = treeport_session_keeper::process::identity(std::process::id())?
            .context("Cannot verify keeper identity")?;
        treeport_session_keeper::process::signal(&own, 0)
            .context("Rust sessions require Linux pidfd_open/pidfd_send_signal support")?;
    }
    let journal = Journal::new(&directory, manifest.journal_limit_bytes)?;
    // Socket creation happens under a private parent directory (the engine's
    // responsibility) and chmod is complete before any peer can be accepted.
    let ipc = fs::symlink_metadata(
        PathBuf::from(&manifest.socket_path)
            .parent()
            .context("Missing socket parent")?,
    )?;
    if !ipc.is_dir() || ipc.uid() != unsafe { libc::geteuid() } || ipc.mode() & 0o077 != 0 {
        bail!("Session socket directory must be private and owned by the current user");
    }
    let listener = std::os::unix::net::UnixListener::bind(&manifest.socket_path)?;
    fs::set_permissions(&manifest.socket_path, fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(async move {
        let listener = tokio::net::UnixListener::from_std(listener)?;
        // Create the storage worker before releasing a verified command. A
        // thread-creation failure must not happen after user code starts.
        let storage = Storage::start(directory, journal);
        let pty = Pty::spawn(&manifest)?;
        let token = manifest.token.clone();
        let owner = Handle::start(manifest, pty, storage);
        server::serve(listener, token, owner).await
    });
    // Explicit close can cancel a replay whose blocking reader is still inside
    // an OS filesystem call. Do not wait forever for that worker after verified
    // process cleanup and bounded acknowledgement have completed.
    runtime.shutdown_background();
    result
}
