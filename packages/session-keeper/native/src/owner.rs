use crate::{
    process,
    protocol::{Command, FrameLimitExceeded, Manifest, RecordData, Status},
    pty::{self, Capture, Pty},
    storage::{CloseFailure, Storage, StorageBusy},
};
use anyhow::{bail, Context, Result};
use portable_pty::PtySize;
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot, watch};

struct Control {
    command: Command,
    reply: oneshot::Sender<Result<Status>>,
}
#[derive(Clone)]
pub struct Handle {
    commands: mpsc::Sender<Control>,
    closes: mpsc::Sender<Control>,
    input: mpsc::Sender<Vec<u8>>,
    pub status: watch::Receiver<Status>,
    pub storage: Storage,
    pub shutdown: watch::Sender<bool>,
    #[cfg(test)]
    storing: watch::Receiver<bool>,
}
impl Handle {
    pub fn start(manifest: Manifest, pty: Pty, storage: Storage) -> Self {
        let status = Status {
            version: 1,
            owner_pid: std::process::id(),
            pid: pty.pid,
            process: manifest.argv[0].clone(),
            cols: manifest.cols,
            rows: manifest.rows,
            sequence: 0,
            processed_sequence: 0,
            exit_code: None,
            error: None,
            incomplete: false,
            startup_aborted: false,
        };
        let (published, receiver) = watch::channel(status.clone());
        let (commands, incoming) = mpsc::channel(16);
        let (closes, closing) = mpsc::channel(1);
        #[cfg(test)]
        let (storing, in_storage) = watch::channel(false);
        let (shutdown, _) = watch::channel(false);
        let (input, mut input_receiver) = mpsc::channel::<Vec<u8>>(2);
        let descriptor = pty.descriptor.clone();
        tokio::spawn(async move {
            while let Some(bytes) = input_receiver.recv().await {
                if let Err(error) = pty::write(&descriptor, &bytes).await {
                    crate::diagnostics::report(format!("PTY input failed: {error}"));
                }
            }
        });
        let handle = Self {
            commands,
            closes,
            input,
            status: receiver,
            storage: storage.clone(),
            shutdown,
            #[cfg(test)]
            storing: in_storage,
        };
        tokio::spawn(async move {
            let mut owner = Owner {
                manifest,
                pty,
                storage,
                status,
                published,
                incoming,
                closing,
                deferred_close: None,
                closing_storage: None,
                cleanup_verified: false,
                #[cfg(test)]
                storing,
                pending: None,
                eof: false,
                exited: false,
                exit_code: None,
                exit_recorded: false,
            };
            owner.storage.status(owner.status.clone());
            if let Err(error) = owner.run().await {
                crate::diagnostics::report(format!("Session owner failed: {error:#}"));
            }
        });
        handle
    }
    pub async fn command(&self, command: Command) -> Result<Status> {
        if let Command::Write { data, encoding } = command {
            if self.status.borrow().exit_code.is_none() {
                let bytes = data.into_bytes(encoding)?;
                self.input
                    .send(bytes)
                    .await
                    .context("PTY input queue closed")?;
            }
            return Ok(self.status.borrow().clone());
        }
        let (reply, receiver) = oneshot::channel();
        let sender = if matches!(command, Command::Terminate { .. }) {
            &self.closes
        } else {
            &self.commands
        };
        sender.send(Control { command, reply }).await?;
        receiver.await?
    }
}
type ClosingStorage = Pin<Box<dyn Future<Output = Result<()>> + Send>>;

struct Owner {
    manifest: Manifest,
    pty: Pty,
    storage: Storage,
    status: Status,
    published: watch::Sender<Status>,
    incoming: mpsc::Receiver<Control>,
    closing: mpsc::Receiver<Control>,
    deferred_close: Option<Control>,
    closing_storage: Option<ClosingStorage>,
    cleanup_verified: bool,
    #[cfg(test)]
    storing: watch::Sender<bool>,
    pending: Option<(RecordData, u64)>,
    eof: bool,
    exited: bool,
    exit_code: Option<i32>,
    exit_recorded: bool,
}
impl Owner {
    async fn stop_processes(&mut self) -> Result<()> {
        if self.cleanup_verified {
            return Ok(());
        }
        let ownership = Arc::clone(&self.pty.ownership);
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut ownership = ownership.lock().unwrap();
            for signal in [libc::SIGTERM, libc::SIGKILL] {
                let targets = ownership.discover(&process::snapshot()?)?;
                for target in targets {
                    process::signal(&target, signal)?;
                }
                if signal == libc::SIGTERM {
                    let deadline = Instant::now() + Duration::from_millis(500);
                    loop {
                        if ownership.discover(&process::snapshot()?)?.is_empty() {
                            return Ok(());
                        }
                        if Instant::now() >= deadline {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                }
            }
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                if ownership.discover(&process::snapshot()?)?.is_empty() {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    bail!("Session cleanup left verified processes running");
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        })
        .await??;
        let _ = self.pty.reap.try_send(());
        self.cleanup_verified = true;
        Ok(())
    }
    async fn wait_storage<T>(
        &mut self,
        operation: impl std::future::Future<Output = Result<T>>,
    ) -> Result<T> {
        tokio::pin!(operation);
        #[cfg(test)]
        self.storing.send_replace(true);
        let mut close_channel_ended = false;
        loop {
            tokio::select! {
                biased;
                result = &mut operation => {
                    #[cfg(test)]
                    self.storing.send_replace(false);
                    return result;
                }
                close = async {
                    if let Some(close) = self.deferred_close.take() {
                        Some(close)
                    } else {
                        self.closing.recv().await
                    }
                }, if !close_channel_ended => {
                    let Some(close) = close else {
                        close_channel_ended = true;
                        continue;
                    };
                    let error = match self.stop_processes().await {
                        Ok(()) => {
                            let completed = tokio::time::timeout(
                                Duration::from_millis(250),
                                &mut operation,
                            )
                            .await
                            .ok();
                            if let Some(result) = completed {
                                self.deferred_close = Some(close);
                                #[cfg(test)]
                                self.storing.send_replace(false);
                                return result;
                            }
                            self.eof = true;
                            self.exit_recorded = true;
                            anyhow::anyhow!("Session processes stopped, but storage is still in flight; authenticated close must retry after it completes")
                        }
                        Err(error) => error.context("Session cleanup failed while storage is still in flight"),
                    };
                    self.status.incomplete = true;
                    self.status.error = Some(format!("{error:#}"));
                    self.publish(true);
                    let _ = close.reply.send(Err(error));
                }
            }
        }
    }
    fn publish(&self, disk: bool) {
        self.published.send_replace(self.status.clone());
        if disk && self.closing_storage.is_none() {
            self.storage.status(self.status.clone());
        }
    }
    async fn append(&mut self, data: RecordData, at: u64) -> Result<()> {
        let storage = self.storage.clone();
        match self.wait_storage(storage.append(data.clone(), at)).await {
            Ok(record) => {
                self.status.sequence = record.sequence;
                match record.data {
                    RecordData::Exit { exit_code } => {
                        self.status.exit_code = Some(exit_code);
                    }
                    RecordData::Resize { cols, rows } => {
                        if !self.exited {
                            if let Err(error) = self.pty.master.resize(PtySize {
                                cols: cols as u16,
                                rows: rows as u16,
                                pixel_width: 0,
                                pixel_height: 0,
                            }) {
                                self.status.error = Some(format!("Cannot resize PTY: {error:#}"));
                                self.status.incomplete = true;
                            }
                        }
                        self.status.cols = cols;
                        self.status.rows = rows;
                    }
                    _ => {}
                }
                self.pending = None;
                if !self.status.incomplete {
                    self.status.error = None;
                }
                self.publish(false);
            }
            Err(error) => {
                if error.downcast_ref::<FrameLimitExceeded>().is_some() {
                    return Err(error);
                }
                self.status.error = Some(format!("{error:#}"));
                self.pending = Some((data, at));
                self.publish(true);
            }
        }
        Ok(())
    }
    async fn run(&mut self) -> Result<()> {
        loop {
            tokio::select! {
                capture = self.pty.capture.recv(), if self.pending.is_none() && !self.eof => {
                    match capture {
                        Some(Capture::Output(mut data)) => {
                            let target = self.manifest.journal_limit_bytes
                                .saturating_sub(128 + 6 * 4096)
                                .max(6 * 4096);
                            let raw_target = if self.manifest.journal_limit_bytes < 128 + 6 * 8192 {
                                4096
                            } else {
                                32 * 1024
                            };
                            let encoded_len = |text: &str| text.bytes().map(|byte| match byte {
                                b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
                                0..=31 => 6,
                                _ => 1,
                            }).sum::<u64>();
                            let mut bytes = encoded_len(&data);
                            for _ in 0..31 {
                                if bytes >= target || data.len() >= raw_target { break; }
                                match self.pty.capture.try_recv() {
                                    Ok(Capture::Output(next)) => {
                                        bytes += encoded_len(&next);
                                        data.push_str(&next);
                                    },
                                    Ok(Capture::Eof) => { self.eof = true; break; }
                                    Ok(Capture::Error(error)) => {
                                        self.eof = true;
                                        self.status.error = Some(error);
                                        self.status.incomplete = true;
                                        break;
                                    }
                                    Err(_) => break,
                                }
                            }
                            self.append(RecordData::Output { data }, now()).await?;
                        }
                        Some(Capture::Eof) | None => self.eof = true,
                        Some(Capture::Error(error)) => {
                            self.eof = true;
                            self.status.error = Some(error);
                            self.status.incomplete = true;
                            self.publish(true);
                        }
                    }
                }
                exit = &mut self.pty.exit, if !self.exited => {
                    self.exited = true;
                    match exit? {
                        Ok(code) => self.exit_code = Some(code),
                        Err(error) => {
                            self.exit_code = Some(1);
                            self.status.error = Some(format!("Cannot wait for PTY: {error:#}"));
                            self.status.incomplete = true;
                        }
                    }
                    self.publish(true);
                }
                control = async {
                    if let Some(close) = self.deferred_close.take() { return Some(close); }
                    tokio::select! {
                        biased;
                        close = self.closing.recv() => close,
                        normal = self.incoming.recv() => normal,
                    }
                } => {
                    let control = control.context("Session command channel closed")?;
                    let terminate = matches!(control.command, Command::Terminate { .. });
                    let result = self.control(control.command).await;
                    let success = result.is_ok();
                    let _ = control.reply.send(result.map(|_| self.status.clone()));
                    if terminate && success {
                        while let Some(control) = tokio::select! {
                            biased;
                            close = self.closing.recv() => close,
                            normal = self.incoming.recv() => normal,
                        } {
                            let result = if matches!(control.command, Command::Terminate { .. }) {
                                Ok(self.status.clone())
                            } else {
                                Err(anyhow::anyhow!("Session has already closed"))
                            };
                            let _ = control.reply.send(result);
                        }
                        return Ok(());
                    }
                }
            }
            if self.eof && self.exited && !self.exit_recorded && self.pending.is_none() {
                self.exit_recorded = true;
                self.append(
                    RecordData::Exit {
                        exit_code: self.exit_code.unwrap_or(1),
                    },
                    now(),
                )
                .await?;
                self.publish(true);
            }
        }
    }
    async fn control(&mut self, command: Command) -> Result<()> {
        if self.closing_storage.is_some()
            && !matches!(
                command,
                Command::Terminate { .. }
                    | Command::Inspect { .. }
                    | Command::Status
                    | Command::Processed { .. }
            )
        {
            bail!("Session storage close is still in flight; storage mutations are refused");
        }
        if !self.exited
            && !self.cleanup_verified
            && matches!(command, Command::Attach { .. } | Command::Status)
        {
            let descriptor = self.pty.descriptor.clone();
            if let Some(name) =
                tokio::task::spawn_blocking(move || pty::foreground_name(&descriptor)).await??
            {
                self.status.process = name;
                self.publish(false);
            }
        }
        match command {
            Command::Attach {
                journal_limit_bytes,
                ..
            } => {
                if let Some(limit) = journal_limit_bytes {
                    let mut updated = self.manifest.clone();
                    updated.journal_limit_bytes = limit;
                    let storage = self.storage.clone();
                    self.wait_storage(storage.manifest(updated.clone())).await?;
                    self.wait_storage(storage.limit(limit)).await?;
                    self.manifest = updated;
                }
                if !self.status.incomplete {
                    if let Some((data, at)) = self.pending.take() {
                        self.append(data, at).await?;
                    }
                }
                self.publish(true);
            }
            Command::Status | Command::Inspect { .. } => {}
            Command::Processed { sequence } => {
                self.status.processed_sequence = self.status.processed_sequence.max(sequence);
                self.publish(false);
            }
            Command::Write { .. } => bail!("Input belongs to the bounded PTY writer"),
            Command::Resize { cols, rows } => {
                self.record_control(RecordData::Resize { cols, rows })
                    .await?;
                self.publish(true);
            }
            Command::Marker { data } => self.record_control(RecordData::Marker { data }).await?,
            Command::Metadata { metadata } => {
                let mut updated = self.manifest.clone();
                updated.metadata = metadata;
                let storage = self.storage.clone();
                self.wait_storage(storage.manifest(updated.clone())).await?;
                self.manifest = updated;
            }
            Command::Signal { signal } => {
                if !self.exited {
                    let leader = self.pty.ownership.lock().unwrap().leader.clone();
                    tokio::task::spawn_blocking(move || process::signal(&leader, signal.number()))
                        .await??;
                }
            }
            Command::Terminate { .. } => {
                self.stop_processes().await?;
                if self.closing_storage.is_none() {
                    let storage = self.storage.clone();
                    let manifest = self.manifest.clone();
                    self.closing_storage = Some(Box::pin(async move {
                        if let Err(error) = storage.close().await {
                            if error
                                .downcast_ref::<CloseFailure>()
                                .is_some_and(|failure| failure.partial)
                            {
                                if let Err(recovery) = storage.manifest(manifest.clone()).await {
                                    crate::diagnostics::report(format!(
                                        "Cannot retain failed-close discovery: {recovery:#}"
                                    ));
                                }
                            }
                            return Err(error);
                        }
                        Ok(())
                    }));
                }
                let result = tokio::time::timeout(
                    Duration::from_secs(2),
                    self.closing_storage.as_mut().unwrap().as_mut(),
                )
                .await;
                let result = match result {
                    Ok(result) => {
                        self.closing_storage = None;
                        result
                    }
                    Err(_) => {
                        self.eof = true;
                        self.exit_recorded = true;
                        self.status.incomplete = true;
                        let error = anyhow::anyhow!("Session storage close is still in flight; deletion or discovery recovery may still complete. Retry authenticated close; no new transaction will be admitted");
                        self.status.error = Some(format!("{error:#}"));
                        self.publish(false);
                        return Err(error);
                    }
                };
                if let Err(error) = result {
                    if error.downcast_ref::<StorageBusy>().is_some() {
                        self.eof = true;
                        self.exit_recorded = true;
                        self.status.incomplete = true;
                        self.status.error = Some(format!("{error:#}"));
                        self.publish(true);
                    } else if error
                        .downcast_ref::<CloseFailure>()
                        .is_some_and(|failure| failure.partial)
                    {
                        self.eof = true;
                        self.exit_recorded = true;
                        self.status.incomplete = true;
                        self.status.error = Some(format!(
                            "Session close partially removed storage: {error:#}"
                        ));
                        self.publish(true);
                    } else if error.downcast_ref::<CloseFailure>().is_none() {
                        self.eof = true;
                        self.exit_recorded = true;
                        self.status.incomplete = true;
                        self.status.error = Some(format!("Session close failed: {error:#}"));
                        self.publish(false);
                    }
                    return Err(error);
                }
                let socket = self.manifest.socket_path.clone();
                tokio::task::spawn_blocking(move || -> Result<()> {
                    match std::fs::remove_file(socket) {
                        Ok(()) => Ok(()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                        Err(error) => Err(error.into()),
                    }
                })
                .await??;
            }
            Command::Pause { .. } => bail!("Pause belongs to the attached engine"),
        }
        Ok(())
    }
    async fn record_control(&mut self, data: RecordData) -> Result<()> {
        if let Some(error) = &self.status.error {
            bail!("{error}");
        }
        self.append(data, now()).await?;
        if let Some(error) = &self.status.error {
            bail!("{error}");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
