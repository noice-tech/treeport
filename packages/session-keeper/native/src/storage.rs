use crate::{
    journal::{atomic_json, Journal, Snapshot},
    protocol::{Manifest, Record, RecordData, Status},
};
use anyhow::{Context, Result};

// Match the retained journal reader's directory budget. Close must not recurse
// into arbitrary injected trees or perform an unbounded enumeration.
const MAX_SESSION_ENTRIES: usize = 65_536;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::Duration,
};
use tokio::sync::{mpsc, oneshot, Mutex, OwnedMutexGuard};

#[derive(Debug)]
pub struct StorageBusy;
impl std::fmt::Display for StorageBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Session storage is still in flight; no storage deletion was admitted. Retry authenticated close after it completes")
    }
}
impl std::error::Error for StorageBusy {}

enum Operation {
    Append(RecordData, u64, oneshot::Sender<Result<Record>>),
    Snapshot(u64, oneshot::Sender<Result<Snapshot>>),
    Manifest(Manifest, oneshot::Sender<Result<()>>),
    Status(Status),
    Limit(u64, oneshot::Sender<()>),
    Close(oneshot::Sender<Result<()>>),
    #[cfg(test)]
    Stall(oneshot::Sender<()>, oneshot::Receiver<()>),
}

// Test-only worker barrier: block the actual serialized worker, not a mocked
// append result. Dropping the guard always releases it, including on failure.
#[cfg(test)]
pub(crate) struct Stall(Option<oneshot::Sender<()>>);
#[cfg(test)]
impl Drop for Stall {
    fn drop(&mut self) {
        if let Some(release) = self.0.take() {
            let _ = release.send(());
        }
    }
}
#[cfg(test)]
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum StallPhase {
    Close,
    Manifest,
}
#[cfg(test)]
type OperationStall = (StallPhase, oneshot::Sender<()>, oneshot::Receiver<()>);

#[derive(Clone)]
pub struct Storage {
    sender: mpsc::Sender<(Operation, OwnedMutexGuard<()>)>,
    gate: Arc<Mutex<()>>,
    #[cfg(test)]
    operation_stall: Arc<std::sync::Mutex<Option<OperationStall>>>,
}
impl Storage {
    #[cfg(test)]
    pub fn start(directory: PathBuf, journal: Journal) -> Self {
        Self::start_owned(directory, journal, None)
    }
    pub fn start_leased(
        directory: PathBuf,
        journal: Journal,
        lease: Arc<std::sync::Mutex<crate::lease::SessionLease>>,
    ) -> Self {
        Self::start_owned(directory, journal, Some(lease))
    }
    fn start_owned(
        directory: PathBuf,
        journal: Journal,
        lease: Option<Arc<std::sync::Mutex<crate::lease::SessionLease>>>,
    ) -> Self {
        let (sender, mut receiver) = mpsc::channel(8);
        let gate = Arc::new(Mutex::new(()));
        #[cfg(test)]
        let operation_stall = Arc::new(std::sync::Mutex::new(None::<OperationStall>));
        #[cfg(test)]
        let worker_stall = operation_stall.clone();
        thread::spawn(move || {
            // A canceled runtime can leave admitted writes in flight. Keep
            // recovery excluded until this worker exits (or the process dies).
            let _lease = lease;
            let mut journal = Some(journal);
            while let Some((operation, _guard)) = receiver.blocking_recv() {
                #[cfg(test)]
                {
                    // Stall AFTER exclusive admission, on the actual worker.
                    // Never hold the configuration lock while it is blocked.
                    let phase = match &operation {
                        Operation::Close(_) => Some(StallPhase::Close),
                        Operation::Manifest(_, _) => Some(StallPhase::Manifest),
                        _ => None,
                    };
                    let stalled = {
                        let mut armed = worker_stall.lock().unwrap();
                        if armed
                            .as_ref()
                            .is_some_and(|(expected, _, _)| Some(*expected) == phase)
                        {
                            armed.take()
                        } else {
                            None
                        }
                    };
                    if let Some((_, started, release)) = stalled {
                        let _ = started.send(());
                        let _ = release.blocking_recv();
                    }
                }
                match operation {
                    #[cfg(test)]
                    Operation::Stall(started, release) => {
                        let _ = started.send(());
                        let _ = release.blocking_recv();
                    }
                    Operation::Append(data, at, reply) => {
                        let result = journal
                            .as_mut()
                            .context("Journal closed")
                            .and_then(|journal| journal.append(data, at));
                        let _ = reply.send(result);
                    }
                    Operation::Snapshot(after, reply) => {
                        let result = journal
                            .as_ref()
                            .context("Journal closed")
                            .and_then(|journal| journal.snapshot(after));
                        let _ = reply.send(result);
                    }
                    Operation::Manifest(manifest, reply) => {
                        let _ = reply.send(atomic_json(&directory, "manifest.json", &manifest));
                    }
                    Operation::Status(status) => {
                        if let Err(error) = atomic_json(&directory, "status.json", &status) {
                            crate::diagnostics::report(format!(
                                "Cannot publish session status: {error:#}"
                            ));
                        }
                    }
                    Operation::Limit(limit, reply) => {
                        if let Some(journal) = &mut journal {
                            journal.limit_bytes = limit;
                        }
                        let _ = reply.send(());
                    }
                    Operation::Close(reply) => {
                        let result = remove_session(&directory, MAX_SESSION_ENTRIES);
                        // A refused deletion is not a closed journal. Retain
                        // its descriptor and commit state so pending EOF/exit
                        // capture and authenticated close can still retry.
                        // This does not undo an OS-level partial deletion.
                        if result.is_ok() {
                            journal.take();
                        }
                        let _ = reply.send(result);
                    }
                }
            }
        });
        Self {
            sender,
            gate,
            #[cfg(test)]
            operation_stall,
        }
    }
    async fn enqueue(&self, operation: Operation) -> Result<()> {
        let guard = self.gate.clone().lock_owned().await;
        // The worker, not the requesting future, owns this guard. Canceling a
        // peer must never make an accepted write appear idle before it commits.
        self.sender.send((operation, guard)).await?;
        Ok(())
    }
    #[cfg(test)]
    pub(crate) async fn stall(&self) -> Result<Stall> {
        let (started, receiver) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        let guard = Stall(Some(release));
        self.enqueue(Operation::Stall(started, blocked)).await?;
        receiver.await?;
        Ok(guard)
    }
    #[cfg(test)]
    pub(crate) fn stall_next(&self, phase: StallPhase) -> (oneshot::Receiver<()>, Stall) {
        let (started, receiver) = oneshot::channel();
        let (release, blocked) = oneshot::channel();
        assert!(self
            .operation_stall
            .lock()
            .unwrap()
            .replace((phase, started, blocked))
            .is_none());
        (receiver, Stall(Some(release)))
    }
    pub async fn append(&self, data: RecordData, at: u64) -> Result<Record> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(Operation::Append(data, at, tx)).await?;
        rx.await?
    }
    pub async fn snapshot(&self, after: u64) -> Result<Snapshot> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(Operation::Snapshot(after, tx)).await?;
        rx.await?
    }
    pub async fn manifest(&self, manifest: Manifest) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(Operation::Manifest(manifest, tx)).await?;
        rx.await?
    }
    pub async fn limit(&self, limit: u64) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(Operation::Limit(limit, tx)).await?;
        rx.await?;
        Ok(())
    }
    pub fn status(&self, status: Status) {
        // Diagnostics must never backpressure capture or control. The socket's
        // watch status remains authoritative if the bounded worker is busy.
        let Ok(guard) = self.gate.clone().try_lock_owned() else {
            return;
        };
        if let Err(error) = self.sender.try_send((Operation::Status(status), guard)) {
            if matches!(error, mpsc::error::TrySendError::Closed(_)) {
                crate::diagnostics::report(
                    "Cannot publish session status: storage worker closed".into(),
                );
            }
        }
    }
    pub async fn close(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        // Only close admission is timed out. No delete is submitted without
        // the exclusive worker guard; never cancel an admitted filesystem
        // operation, which could still commit/unlink after the caller returns.
        let guard = tokio::time::timeout(Duration::from_secs(1), self.gate.clone().lock_owned())
            .await
            .map_err(|_| StorageBusy)?;
        self.sender.send((Operation::Close(tx), guard)).await?;
        rx.await?
    }
}

// The wire remains v1: this internal error only lets the owner distinguish a
// refused delete from possibly destructive progress and stop claiming capture.
#[derive(Debug)]
pub struct CloseFailure {
    pub partial: bool,
    cause: io::Error,
}
impl std::fmt::Display for CloseFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.cause, formatter)
    }
}
impl std::error::Error for CloseFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

pub(crate) fn remove_retained_session(lease: &crate::lease::SessionLease) -> Result<()> {
    remove_session(lease.directory(), MAX_SESSION_ENTRIES)
}

fn remove_session(directory: &Path, entry_limit: usize) -> Result<()> {
    let mut partial = false;
    let result = (|| -> io::Result<()> {
        let metadata = match fs::symlink_metadata(directory) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if !metadata.is_dir() {
            return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
        }
        // Complete bounded admission before touching even owner.log. Retained
        // journals are flat; an unexpected directory is not owned payload and
        // must be repaired explicitly, never traversed recursively by close.
        let payloads = || -> io::Result<Vec<std::ffi::OsString>> {
            let mut names = Vec::new();
            for (index, entry) in fs::read_dir(directory)?.enumerate() {
                if index >= entry_limit {
                    return Err(io::Error::other("Session storage exceeds the entry limit"));
                }
                let entry = entry?;
                let name = entry.file_name();
                if matches!(name.to_str(), Some("manifest.json" | "status.json")) {
                    continue;
                }
                if entry.file_type()?.is_dir() {
                    return Err(io::Error::other("Session storage contains an unexpected directory; refusing recursive close"));
                }
                names.push(name);
            }
            Ok(names)
        };
        let names = payloads()?;
        // Delete the bootstrap log first, then retained data. Never destroy the
        // token/discovery files because a later payload cannot be removed.
        match fs::remove_file(directory.join("owner.log")) {
            Ok(()) => partial = true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                // EACCES is a refused operation. Other failures (such as EIO)
                // need not prove that the filesystem made no change.
                partial = error.kind() != io::ErrorKind::PermissionDenied;
                return Err(error);
            }
        }
        for name in names {
            if name == "owner.log" {
                continue;
            }
            // Unlink symlinks and FIFOs themselves; never follow their data.
            // A payload replaced with a directory after admission fails unlink
            // instead of granting authority to traverse the new tree.
            partial = true;
            fs::remove_file(directory.join(name))?;
        }
        // Re-check with the SAME entry bound before consuming discovery. A
        // concurrent writer cannot turn this final scan into unbounded work.
        if !payloads()?.is_empty() {
            return Err(io::Error::other("Session storage changed during close"));
        }
        for name in ["status.json", "manifest.json"] {
            match fs::remove_file(directory.join(name)) {
                Ok(()) => partial = true,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        fs::remove_dir(directory)
    })();
    result.map_err(|cause| CloseFailure { partial, cause }.into())
}
