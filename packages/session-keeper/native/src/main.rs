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
    journal::{atomic_json, open_regular, Journal},
    lease::{self, SessionLease},
    owner::Handle,
    protocol::{Manifest, RecordData, Status, MAX_MANIFEST_BYTES},
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
        let title = args.next().context("Missing process title")?;
        if args.next().is_some() {
            bail!("Unexpected detach arguments");
        }
        let mut command = std::process::Command::new(std::env::current_exe()?);
        command.arg(directory);
        command.arg0(title);
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
    let recovering = first == "--recover";
    let directory = PathBuf::from(if recovering {
        args.next().context("Missing session directory")?
    } else {
        first
    });
    if args.next().is_some() {
        bail!("Unexpected session keeper arguments");
    }
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
    if manifest_file.metadata()?.len() > MAX_MANIFEST_BYTES as u64 {
        bail!("Session manifest exceeds the byte limit");
    }
    let manifest = Manifest::read(manifest_file)?;
    if recovering {
        return lease::recover(&directory, &manifest);
    }
    let lease = std::sync::Arc::new(std::sync::Mutex::new(SessionLease::acquire(
        &directory, &manifest, true,
    )?));
    #[cfg(target_os = "linux")]
    {
        // pidfd signaling needs Linux >=5.3 and a permitting seccomp policy.
        let own = treeport_session_keeper::process::identity(std::process::id())?
            .context("Cannot verify keeper identity")?;
        treeport_session_keeper::process::signal(&own, 0)
            .context("Rust sessions require Linux pidfd_open/pidfd_send_signal support")?;
    }
    let journal = Journal::new(&directory, manifest.journal_limit_bytes)?;
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
        let storage = Storage::start_leased(directory.clone(), journal, lease.clone());
        let spawned = Pty::spawn_leased(
            &manifest,
            &mut *lease
                .lock()
                .map_err(|_| anyhow::anyhow!("Session lease poisoned"))?,
        );
        let pty = match spawned {
            Ok(pty) => pty,
            Err(error) => {
                drop(listener);
                fs::remove_file(&manifest.socket_path)?;
                let message = format!("Terminal startup aborted: {error:#}");
                let at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_millis() as u64;
                storage
                    .append(
                        RecordData::Output {
                            data: format!("{message}\r\n"),
                        },
                        at,
                    )
                    .await?;
                let exit = storage
                    .append(RecordData::Exit { exit_code: 1 }, at)
                    .await?;
                atomic_json(
                    &directory,
                    "status.json",
                    &Status {
                        version: 1,
                        owner_pid: std::process::id(),
                        pid: 0,
                        process: manifest.argv[0].clone(),
                        command_line: Vec::new(),
                        cols: manifest.cols,
                        rows: manifest.rows,
                        sequence: exit.sequence,
                        processed_sequence: 0,
                        exit_code: Some(1),
                        error: Some(message),
                        incomplete: false,
                        startup_aborted: true,
                    },
                )?;
                return Err(error);
            }
        };
        let token = manifest.token.clone();
        let owner = Handle::start(manifest, pty, storage);
        let result = server::serve(listener, token, owner).await;
        drop(lease);
        result
    });
    runtime.shutdown_background();
    result
}
