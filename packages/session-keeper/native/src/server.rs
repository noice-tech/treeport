use crate::{
    journal::Snapshot,
    owner::Handle,
    protocol::{encode_jsonl, Command, Frame, Request, RequestId, Status, MAX_FRAME_BYTES},
};
use anyhow::{bail, Context, Result};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{unix::OwnedWriteHalf, UnixListener, UnixStream},
    sync::{mpsc, watch, Semaphore},
};

struct Engines {
    current: Mutex<Option<u64>>,
    generation: watch::Sender<u64>,
}
struct Lease {
    engines: Arc<Engines>,
    generation: u64,
}
impl Engines {
    fn acquire(self: &Arc<Self>, replace: bool) -> Result<Lease> {
        let mut current = self.current.lock().unwrap();
        if current.is_some() && !replace {
            bail!("Another engine is attached");
        }
        let generation = *self.generation.borrow() + 1;
        *current = Some(generation);
        self.generation.send_replace(generation);
        Ok(Lease {
            engines: self.clone(),
            generation,
        })
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut current = self.engines.current.lock().unwrap();
        if *current == Some(self.generation) {
            *current = None;
        }
    }
}

pub async fn serve(listener: UnixListener, token: String, owner: Handle) -> Result<()> {
    let (generation, _) = watch::channel(0);
    let engines = Arc::new(Engines {
        current: Mutex::new(None),
        generation,
    });
    let admission = Arc::new(Semaphore::new(32));
    let mut shutdown = owner.shutdown.subscribe();
    let mut listener_error = None;
    loop {
        tokio::select! {
            _ = shutdown.changed() => return Ok(()),
            accepted = listener.accept() => {
                let (socket, _) = match accepted {
                    Ok(peer) => { listener_error = None; peer },
                    Err(error) => {
                        let message = error.to_string();
                        if listener_error.as_ref() != Some(&message) { crate::diagnostics::report(format!("Session listener failed: {message}; PTY capture remains alive")); }
                        listener_error = Some(message);
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                };
                let Ok(permit) = admission.clone().try_acquire_owned() else { drop(socket); continue; };
                let token = token.clone();
                let owner = owner.clone();
                let engines = engines.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(error) = connection(socket, token, owner, engines).await {
                        crate::diagnostics::report(format!("Session peer detached: {error:#}"));
                    }
                });
            }
        }
    }
}
async fn frame(writer: &mut OwnedWriteHalf, frame: &impl serde::Serialize) -> Result<()> {
    writer.write_all(&encode_jsonl(frame)?).await?;
    Ok(())
}
async fn response(
    writer: &mut OwnedWriteHalf,
    id: RequestId,
    status: Option<Status>,
    error: Option<String>,
) -> Result<()> {
    frame(writer, &Frame::Response { id, status, error }).await
}
async fn finish_close(
    writer: &mut OwnedWriteHalf,
    owner: &Handle,
    id: RequestId,
    status: Status,
) -> Result<()> {
    let sent = tokio::time::timeout(Duration::from_secs(1), async {
        response(writer, id, Some(status), None).await?;
        writer.shutdown().await?;
        Ok::<(), anyhow::Error>(())
    })
    .await;
    owner.shutdown.send_replace(true);
    sent.context("Timed out acknowledging session close")?
}
async fn request(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Result<Request> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().await?;
        if bytes.is_empty() {
            bail!("Engine disconnected");
        }
        let boundary = bytes.iter().position(|b| *b == b'\n');
        let count = boundary.map_or(bytes.len(), |position| position + 1);
        if line.len() + count > MAX_FRAME_BYTES {
            bail!("Session request exceeds the frame limit");
        }
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count);
        if boundary.is_some() {
            return Request::parse(&line);
        }
    }
}
async fn connection(
    socket: UnixStream,
    token: String,
    owner: Handle,
    engines: Arc<Engines>,
) -> Result<()> {
    let (read, mut writer) = socket.into_split();
    let mut reader = BufReader::new(read);
    let first = match tokio::time::timeout(Duration::from_secs(10), request(&mut reader)).await {
        Ok(Ok(request)) => request,
        Ok(Err(error)) => {
            frame(
                &mut writer,
                &Frame::Fault {
                    message: format!("{error:#}"),
                },
            )
            .await?;
            return Ok(());
        }
        Err(_) => return Ok(()),
    };
    let supplied = match &first.command {
        Command::Attach { token, .. } | Command::Inspect { token } => Some(token.as_str()),
        Command::Terminate { token } => token.as_deref(),
        _ => None,
    };
    if !supplied.is_some_and(|supplied| bool::from(supplied.as_bytes().ct_eq(token.as_bytes()))) {
        response(
            &mut writer,
            first.id,
            None,
            Some("Session authentication failed or another engine is attached".into()),
        )
        .await?;
        return Ok(());
    }
    if matches!(first.command, Command::Inspect { .. }) {
        let status = owner.status.borrow().clone();
        if let Err(error) = response(&mut writer, first.id, Some(status), None).await {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                frame(
                    &mut writer,
                    &Frame::Fault {
                        message: format!("{error:#}"),
                    },
                ),
            )
            .await;
            return Err(error);
        }
        return Ok(());
    }
    let independent_close = matches!(first.command, Command::Terminate { .. });
    let lease = match engines.acquire(independent_close) {
        Ok(lease) => lease,
        Err(_) => {
            response(
                &mut writer,
                first.id,
                None,
                Some("Session authentication failed or another engine is attached".into()),
            )
            .await?;
            return Ok(());
        }
    };
    let mut generation = engines.generation.subscribe();
    let work = async {
        if independent_close {
            match owner.command(first.command).await {
                Ok(status) => {
                    return finish_close(&mut writer, &owner, first.id, status).await;
                }
                Err(error) => {
                    frame(
                        &mut writer,
                        &Frame::Fault {
                            message: format!("{error:#}"),
                        },
                    )
                    .await?;
                    return Ok(());
                }
            }
        }
        let status = owner.command(first.command).await?;
        let snapshot = owner.storage.snapshot(0).await?;
        let fence = snapshot.fence;
        response(&mut writer, first.id, Some(status), None).await?;
        let mut sent = 0;
        replay(snapshot, fence, &mut sent, &mut writer).await?;
        frame(&mut writer, &Frame::Ready { sequence: fence }).await?;
        let initial_error = owner.status.borrow().error.clone();
        if let Some(message) = &initial_error {
            frame(
                &mut writer,
                &Frame::Fault {
                    message: message.clone(),
                },
            )
            .await?;
        }
        attached(reader, &mut writer, &owner, sent, initial_error).await
    };
    let mut work = Box::pin(work);
    let outcome: Option<Result<()>> = loop {
        tokio::select! {
            result = &mut work => break Some(result),
            changed = generation.changed() => {
                changed?;
                if *generation.borrow_and_update() != lease.generation { break None; }
            }
        }
    };
    drop(work);
    if let Some(Err(error)) = outcome {
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            frame(
                &mut writer,
                &Frame::Fault {
                    message: format!("{error:#}"),
                },
            ),
        )
        .await;
        return Err(error);
    }
    Ok(())
}
type Records = mpsc::Receiver<Result<Option<crate::protocol::Record>>>;
type CommandFuture = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Status>> + Send>>;
fn records(mut snapshot: Snapshot) -> Records {
    let (sender, receiver) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || loop {
        let record = snapshot.next_record();
        let finished = !matches!(record, Ok(Some(_)));
        if sender.blocking_send(record).is_err() || finished {
            break;
        }
    });
    receiver
}

async fn attached(
    mut reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: &mut OwnedWriteHalf,
    owner: &Handle,
    mut sent: u64,
    mut last_error: Option<String>,
) -> Result<()> {
    let (incoming, mut requests) = mpsc::channel(1);
    let reader_task = tokio::spawn(async move {
        loop {
            let next = request(&mut reader).await;
            let failure = next.is_err();
            if incoming.send(next).await.is_err() || failure {
                break;
            }
        }
    });
    struct ReaderTask(tokio::task::JoinHandle<()>);
    impl Drop for ReaderTask {
        fn drop(&mut self) {
            self.0.abort();
        }
    }
    let _reader_task = ReaderTask(reader_task);
    let mut status_events = owner.status.clone();
    let mut paused = true;
    let mut forced_fence = sent;
    let mut stream: Option<Records> = None;
    let mut snapshot_fence = sent;
    let mut reply: Option<(RequestId, Status, u64)> = None;
    let mut operation: Option<CommandFuture> = None;
    let mut operation_reply: Option<(RequestId, bool, bool)> = None;
    loop {
        if reply.as_ref().is_some_and(|(_, _, fence)| *fence <= sent) {
            let (id, status, _) = reply.take().unwrap();
            response(writer, id, Some(status), None).await?;
        }
        let target = if paused {
            forced_fence
        } else {
            status_events.borrow().sequence
        };
        let closing = operation_reply
            .as_ref()
            .is_some_and(|(_, _, terminate)| *terminate);
        if !closing && stream.is_none() && sent < target {
            let snapshot = owner.storage.snapshot(sent).await?;
            snapshot_fence = snapshot.fence;
            stream = Some(records(snapshot));
        }
        tokio::select! {
            next = async { stream.as_mut().unwrap().recv().await }, if !closing && stream.is_some() && sent < target => {
                let record = next.context("Replay worker stopped")??.context("Journal does not reach its captured fence")?;
                sent = record.sequence;
                frame(writer, &record).await?;
                if sent == snapshot_fence { stream = None; }
            }
            completed = async { operation.as_mut().unwrap().await }, if operation.is_some() => {
                operation = None;
                let (id, fenced, terminate) = operation_reply.take().unwrap();
                match completed {
                    Ok(status) => {
                        if terminate { return finish_close(writer, owner, id, status).await; }
                        if fenced {
                            forced_fence = forced_fence.max(status.sequence);
                            let fence = status.sequence;
                            reply = Some((id, status, fence));
                        } else { response(writer, id, Some(status), None).await?; }
                    }
                    Err(error) => { frame(writer, &Frame::Fault { message: format!("{error:#}") }).await?; return Ok(()); }
                }
            }
            incoming = requests.recv(), if reply.is_none() && operation.is_none() => {
                let request = match incoming.context("Engine disconnected")? {
                    Ok(request) => request,
                    Err(error) => { frame(writer, &Frame::Fault { message: format!("{error:#}") }).await?; return Ok(()); }
                };
                if matches!(request.command, Command::Attach { .. } | Command::Inspect { .. }) {
                    response(writer, request.id, None, Some("Session authentication failed or another engine is attached".into())).await?;
                    return Ok(());
                }
                if let Command::Pause { paused: value } = request.command {
                    paused = value;
                    forced_fence = sent;
                    let status = owner.status.borrow().clone();
                    response(writer, request.id, Some(status), None).await?;
                } else {
                    if let Command::Processed { sequence } = request.command {
                        if sequence > sent {
                            frame(writer, &Frame::Fault { message: "Invalid engine processing fence".into() }).await?;
                            return Ok(());
                        }
                    }
                    let fenced = matches!(request.command, Command::Resize { .. } | Command::Marker { .. });
                    let terminate = matches!(request.command, Command::Terminate { .. });
                    operation_reply = Some((request.id, fenced, terminate));
                    let handle = owner.clone();
                    operation = Some(Box::pin(async move { handle.command(request.command).await }));
                }
            }
            changed = status_events.changed(), if !closing => {
                changed?;
                let status = status_events.borrow_and_update().clone();
                if status.error != last_error {
                    last_error = status.error;
                    if let Some(message) = &last_error { frame(writer, &Frame::Fault { message: message.clone() }).await?; }
                }
            }
        }
    }
}
async fn replay(
    snapshot: Snapshot,
    target: u64,
    sent: &mut u64,
    writer: &mut OwnedWriteHalf,
) -> Result<()> {
    let mut records = records(snapshot);
    while *sent < target {
        let record = records
            .recv()
            .await
            .context("Replay worker stopped")??
            .context("Journal does not reach its captured fence")?;
        *sent = record.sequence;
        frame(writer, &record).await?;
    }
    Ok(())
}
