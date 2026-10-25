use crate::{
    journal::{atomic_json, open_regular},
    process,
    protocol::{Manifest, OpaqueString, Status, MAX_MANIFEST_BYTES},
    storage::remove_retained_session,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, Read, Seek, SeekFrom, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Admission {
    device: u64,
    inode: u64,
    token: String,
    socket_path: String,
    owner_pid: u32,
    command: Option<process::Identity>,
}

pub struct SessionLease {
    directory: PathBuf,
    file: File,
    admission: Admission,
}
impl SessionLease {
    pub fn acquire(directory: &Path, manifest: &Manifest, starting: bool) -> Result<Self> {
        if manifest.ownership.as_deref() != Some("lease-v1") {
            bail!("Session predates ownership leases; retain it and close it through its original keeper");
        }
        let metadata = fs::symlink_metadata(directory)?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            bail!("Session directory must be private and owned by the current user");
        }
        let locks = directory
            .parent()
            .context("Missing session parent")?
            .join(".ownership");
        if starting {
            match fs::DirBuilder::new().mode(0o700).create(&locks) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        let lock_metadata = fs::symlink_metadata(&locks).context(
            "Session predates ownership leases; retain it and close it through its original keeper",
        )?;
        if !lock_metadata.is_dir()
            || lock_metadata.uid() != metadata.uid()
            || lock_metadata.mode() & 0o077 != 0
        {
            bail!("Session ownership directory must be private and owned by the current user");
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(starting).mode(0o600);
        let mut file = open_regular(
            &locks.join(directory.file_name().context("Missing session name")?),
            &mut options,
        )
        .context(
            "Session has no ownership lease; retain it and close it through its original keeper",
        )?;
        let file_metadata = file.metadata()?;
        if file_metadata.uid() != metadata.uid()
            || file_metadata.mode() & 0o077 != 0
            || file_metadata.len() > 16 * 1024
        {
            bail!("Session ownership file must be private, bounded and owned by the current user");
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error())
                .context("Session ownership is held; no recovery or deletion was admitted");
        }
        let mut source = String::new();
        Read::by_ref(&mut file)
            .take(16 * 1024)
            .read_to_string(&mut source)?;
        let admission = if starting {
            if !source.is_empty()
                || directory.join("status.json").try_exists()?
                || directory.join("journal.jsonl").try_exists()?
            {
                bail!("Session command was already admitted; refusing to launch it again");
            }
            Admission {
                device: metadata.dev(),
                inode: metadata.ino(),
                token: manifest.token.clone(),
                socket_path: manifest.socket_path.clone(),
                owner_pid: std::process::id(),
                command: None,
            }
        } else {
            let admission: Admission = serde_json::from_str(&source)
                .context("Session admission is incomplete; ownership is unresolved")?;
            if admission.device != metadata.dev()
                || admission.inode != metadata.ino()
                || admission.token != manifest.token
                || admission.socket_path != manifest.socket_path
            {
                bail!("Session ownership lease does not identify its retained directory");
            }
            admission
        };
        let mut lease = Self {
            directory: directory.to_path_buf(),
            file,
            admission,
        };
        if starting {
            lease.publish()?;
        }
        Ok(lease)
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    fn publish(&mut self) -> Result<()> {
        self.file.seek(SeekFrom::Start(0))?;
        self.file.set_len(0)?;
        serde_json::to_writer(&mut self.file, &self.admission)?;
        self.file.sync_all()?;
        Ok(())
    }

    pub fn command(&mut self, identity: process::Identity) -> Result<()> {
        self.admission.command = Some(identity);
        self.publish()
    }
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "lowercase")]
enum RecoveryCommand {
    Release,
    Close,
    Metadata { metadata: OpaqueString },
}

pub fn recover(directory: &Path, manifest: &Manifest) -> Result<()> {
    let lease = SessionLease::acquire(directory, manifest, false)?;
    let status: Status = match open_regular(
        &directory.join("status.json"),
        OpenOptions::new().read(true),
    ) {
        Ok(file) => serde_json::from_reader(file.take(64 * 1024))?,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            let command = lease.admission.command.as_ref().context(
                "Session admission has no command identity or final status; retaining evidence",
            )?;
            Status {
                version: 1,
                owner_pid: lease.admission.owner_pid,
                pid: command.pid,
                process: manifest.argv[0].clone(),
                cols: manifest.cols,
                rows: manifest.rows,
                sequence: 0,
                processed_sequence: 0,
                exit_code: None,
                error: Some(
                    "Keeper status was not retained; final output or exit status may be incomplete"
                        .into(),
                ),
                incomplete: true,
                startup_aborted: false,
            }
        }
        Err(error) => return Err(error),
    };
    println!("{}", serde_json::to_string(&status)?);
    std::io::stdout().flush()?;
    let mut command = String::new();
    std::io::stdin()
        .lock()
        .take((MAX_MANIFEST_BYTES + 1) as u64)
        .read_line(&mut command)?;
    if command.is_empty() {
        return Ok(());
    }
    if command.len() > MAX_MANIFEST_BYTES {
        bail!("Recovery command exceeds the byte limit");
    }
    match serde_json::from_str::<RecoveryCommand>(&command)? {
        RecoveryCommand::Release => Ok(()),
        RecoveryCommand::Metadata { metadata } => {
            let mut updated = manifest.clone();
            updated.metadata = metadata;
            atomic_json(directory, "manifest.json", &updated)
        }
        RecoveryCommand::Close => {
            if !status.startup_aborted {
                let original = lease
                    .admission
                    .command
                    .as_ref()
                    .context("Command ownership is unknown; retaining session evidence")?;
                if process::identity(original.pid)?
                    .is_some_and(|current| current.birth == original.birth)
                {
                    bail!("Session keeper is gone but its recorded command still exists; retaining session evidence");
                }
                if process::snapshot()?
                    .values()
                    .any(|row| row.session == original.session)
                {
                    bail!("Session keeper is gone but its command session still has processes; retaining session evidence");
                }
            }
            remove_retained_session(&lease)?;
            match fs::remove_file(&manifest.socket_path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            Ok(())
        }
    }
}
