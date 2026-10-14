use crate::{
    process::{self, Ownership},
    protocol::{Decoder, Manifest},
};
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, MasterPty, PtySize};
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::fs::OpenOptionsExt,
    sync::{Arc, Mutex},
};
use tokio::{
    io::unix::AsyncFd,
    sync::{mpsc, oneshot},
};

pub enum Capture {
    Output(String),
    Eof,
    Error(String),
}
pub struct Pty {
    pub pid: u32,
    pub master: Box<dyn MasterPty + Send>,
    pub descriptor: Arc<AsyncFd<OwnedFd>>,
    pub capture: mpsc::Receiver<Capture>,
    pub exit: oneshot::Receiver<Result<i32>>,
    pub ownership: Arc<Mutex<Ownership>>,
    pub reap: std::sync::mpsc::SyncSender<()>,
}
mod launch;
#[cfg(test)]
mod tests;

impl Pty {
    pub fn spawn(manifest: &Manifest) -> Result<Self> {
        Self::spawn_identified(manifest, process::identity)
    }
    fn spawn_identified(
        manifest: &Manifest,
        identify: impl FnOnce(u32) -> Result<Option<process::Identity>>,
    ) -> Result<Self> {
        let pair = native_pty_system().openpty(PtySize {
            cols: manifest.cols as u16,
            rows: manifest.rows as u16,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        // Complete fallible descriptor setup before creating a command. An fd
        // limit or reactor-registration failure must not leave an unowned child.
        let raw = pair
            .master
            .as_raw_fd()
            .context("PTY did not expose its descriptor")?;
        // SAFETY: fcntl duplicates a valid descriptor; flags are checked and the
        // returned descriptor is owned exactly once. Nonblocking mode applies
        // to this PTY open description, including portable-pty's master.
        let raw = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 0) };
        if raw < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let descriptor = unsafe { OwnedFd::from_raw_fd(raw) };
        let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error().into());
        }
        let descriptor = Arc::new(AsyncFd::new(descriptor)?);
        // The public slave trait has no descriptor or pre-exec hook. Reopen
        // this freshly allocated, kernel-owned slave while our master keeps
        // its device alive; never open a caller-supplied terminal path.
        let slave_path = pair.master.tty_name().context("PTY has no slave path")?;
        let slave = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NOCTTY)
            .open(slave_path)?;
        // SAFETY: slave owns this live descriptor.
        if unsafe { libc::isatty(slave.as_raw_fd()) } != 1 {
            anyhow::bail!("Allocated PTY slave is not a terminal");
        }
        drop(pair.slave);
        let mut held = launch::hold(manifest, slave, identify)?;
        let (sender, capture) = mpsc::channel(32);
        let reader = descriptor.clone();
        tokio::spawn(async move {
            let mut decoder = Decoder::default();
            loop {
                let result = read(&reader).await;
                match result {
                    Ok(bytes) if !bytes.is_empty() => {
                        let text = decoder.push(&bytes, false);
                        let mut start = 0;
                        while start < text.len() {
                            let mut end = (start + 4096).min(text.len());
                            while !text.is_char_boundary(end) {
                                end -= 1;
                            }
                            if sender
                                .send(Capture::Output(text[start..end].to_owned()))
                                .await
                                .is_err()
                            {
                                return;
                            }
                            start = end;
                        }
                    }
                    Ok(_) => {
                        let tail = decoder.push(&[], true);
                        if !tail.is_empty() {
                            let _ = sender.send(Capture::Output(tail)).await;
                        }
                        let _ = sender.send(Capture::Eof).await;
                        break;
                    }
                    Err(error) => {
                        let _ = sender
                            .send(Capture::Error(format!("PTY capture failed: {error}")))
                            .await;
                        break;
                    }
                }
            }
        });
        let result = Self {
            pid: held.pid,
            master: pair.master,
            descriptor,
            capture,
            exit: held.exit,
            ownership: held.ownership,
            reap: held.reap,
        };
        // All fallible descriptor, worker and ownership setup is complete.
        // Drop denies the child on any error before this one-byte admission.
        // The keeper persists Err as proof that startup was aborted: NEVER add
        // fallible work after allow() or return Err once user code may run.
        held.gate.allow()?;
        Ok(result)
    }
}
pub fn foreground_name(descriptor: &AsyncFd<OwnedFd>) -> Result<Option<String>> {
    // SAFETY: the PTY descriptor remains owned for the duration of this call.
    let group = unsafe { libc::tcgetpgrp(descriptor.get_ref().as_raw_fd()) };
    if group < 0 {
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ENOTTY | libc::EIO)) {
            return Ok(None);
        }
        return Err(error.into());
    }
    if group == 0 {
        return Ok(None);
    }
    Ok(process::identity(group as u32)?.map(|row| row.name))
}

async fn read(descriptor: &AsyncFd<OwnedFd>) -> io::Result<Vec<u8>> {
    loop {
        let mut ready = descriptor.readable().await?;
        match ready.try_io(|inner| {
            let mut bytes = vec![0; 8192];
            // SAFETY: buffer is writable for its full length and fd is owned.
            let count = unsafe {
                libc::read(
                    inner.get_ref().as_raw_fd(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                )
            };
            if count < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EIO) {
                    return Ok(Vec::new());
                }
                return Err(error);
            }
            bytes.truncate(count as usize);
            Ok(bytes)
        }) {
            Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => continue,
            Ok(result) => return result,
            Err(_) => continue,
        }
    }
}
pub async fn write(descriptor: &AsyncFd<OwnedFd>, bytes: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let mut ready = descriptor.writable().await?;
        // A hung-up Linux PTY can keep reporting writable/closed while write
        // returns EAGAIN. Retrying that permanent readiness spins the single-
        // thread runtime and prevents independent close from completing.
        if ready.ready().is_write_closed() {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "PTY input closed",
            ));
        }
        match ready.try_io(|inner| {
            let count = unsafe {
                libc::write(
                    inner.get_ref().as_raw_fd(),
                    bytes[offset..].as_ptr().cast(),
                    bytes.len() - offset,
                )
            };
            match count {
                count if count < 0 => Err(io::Error::last_os_error()),
                0 => Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "PTY input write returned zero",
                )),
                count => Ok(count as usize),
            }
        }) {
            Ok(Ok(count)) => offset += count,
            Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
            Ok(Err(error)) => return Err(error),
            Err(_) => {}
        }
    }
    Ok(())
}
