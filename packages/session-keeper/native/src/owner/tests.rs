use super::*;
use crate::{
    journal::{atomic_json, Journal},
    server,
};
use anyhow::ensure;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, path::Path};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};

async fn wire(socket: &Path, method: &str, token: &str) -> Result<serde_json::Value> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut peer = UnixStream::connect(socket).await?;
        peer.write_all(&serde_json::to_vec(&serde_json::json!({
            "method": method, "id": "storage-stall-probe", "token": token
        }))?)
        .await?;
        peer.write_all(b"\n").await?;
        let mut line = String::new();
        ensure!(
            BufReader::new(peer).read_line(&mut line).await? > 0,
            "Missing wire response"
        );
        Ok(serde_json::from_str(&line)?)
    })
    .await
    .context("Authenticated fixture control timed out")?
}

#[tokio::test]
async fn authenticated_close_bypasses_stalled_storage_and_a_full_control_queue() -> Result<()> {
    for mode in ["append", "manifest", "idle"] {
        let root = tempfile::tempdir()?;
        let directory = root.path().join("session");
        std::fs::create_dir(&directory)?;
        let socket = root.path().join("control.sock");
        let manifest = Manifest {
            version: 1,
            token: "a".repeat(32),
            socket_path: socket.to_string_lossy().into_owned(),
            argv: vec![
                "/bin/sh".into(),
                "-c".into(),
                if mode == "append" {
                    "printf READY; IFS= read -r line".into()
                } else {
                    "IFS= read -r line".into()
                },
            ],
            cwd: root.path().to_string_lossy().into_owned(),
            env: BTreeMap::new(),
            cols: 80,
            rows: 24,
            metadata: "original".into(),
            journal_limit_bytes: 1024 * 1024,
        };
        atomic_json(&directory, "manifest.json", &manifest)?;
        let original = std::fs::read(directory.join("manifest.json"))?;
        let storage = Storage::start(
            directory.clone(),
            Journal::new(&directory, manifest.journal_limit_bytes)?,
        );
        let stalled = storage.stall().await?;
        let pty = Pty::spawn(&manifest)?;
        let pid = pty.pid;
        let owner = Handle::start(manifest.clone(), pty, storage.clone());
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let serving = tokio::spawn(server::serve(
            listener,
            manifest.token.clone(),
            owner.clone(),
        ));
        let metadata = if mode == "manifest" {
            let producer = owner.clone();
            Some(tokio::spawn(async move {
                producer
                    .command(Command::Metadata {
                        metadata: "delayed update".into(),
                    })
                    .await
            }))
        } else {
            None
        };
        let mut backlog = Vec::new();
        let outcome = async {
            if mode != "idle" {
                let mut storing = owner.storing.clone();
                tokio::time::timeout(Duration::from_secs(2), async {
                    while !*storing.borrow_and_update() {
                        storing.changed().await?;
                    }
                    Ok::<_, anyhow::Error>(())
                })
                .await
                .context("Producer never reached blocked storage")??;
                // Cancel the original caller only after its command has been
                // accepted. The actor's eventual manifest commit must survive.
                if let Some(metadata) = &metadata {
                    metadata.abort();
                }
                for _ in 0..16 {
                    let queued = owner.clone();
                    backlog.push(tokio::spawn(async move {
                        queued.command(Command::Processed { sequence: 0 }).await
                    }));
                }
                tokio::time::timeout(Duration::from_secs(2), async {
                    while owner.commands.capacity() != 0 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .context("Control queue did not fill")?;
            }
            let rejected = wire(&socket, "terminate", &"b".repeat(32)).await?;
            ensure!(
                rejected["type"] == "response" && rejected["error"].is_string(),
                "Wrong token admitted"
            );
            ensure!(
                process::identity(pid)?.is_some_and(|row| !row.zombie),
                "Wrong token stopped the command"
            );
            let closing_at = Instant::now();
            let reply = wire(&socket, "terminate", &manifest.token).await?;
            ensure!(closing_at.elapsed() < Duration::from_secs(2));
            ensure!(
                reply["type"] == "fault"
                    && reply["message"]
                        .as_str()
                        .is_some_and(|message| message.contains("storage is still in flight")),
                "{mode}: {reply}"
            );
            tokio::time::timeout(Duration::from_secs(2), async {
                while process::identity(pid)?.is_some() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .context("Verified child was not reaped")??;
            let inspected = wire(&socket, "inspect", &manifest.token).await?;
            ensure!(
                inspected["status"]["incomplete"] == true
                    && inspected["status"]["sequence"] == 0
                    && inspected["status"]["exitCode"].is_null(),
                "Busy close advertised complete capture: {inspected}"
            );
            ensure!(
                std::fs::read(directory.join("manifest.json"))? == original,
                "Discovery changed before blocked storage completed"
            );
            ensure!(
                std::fs::metadata(directory.join("journal.jsonl"))?.len() == 0,
                "Blocked append was published"
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        // Always unblock and close this owned session, including if a check
        // failed. Never signal cached PIDs or let a synthetic stall leak a PTY.
        drop(stalled);
        let resumed = async {
            if let Some(metadata) = metadata {
                let canceled = tokio::time::timeout(Duration::from_secs(3), metadata).await?;
                ensure!(
                    canceled.is_err_and(|error| error.is_cancelled()),
                    "Original caller was not canceled"
                );
            }
            for queued in backlog {
                tokio::time::timeout(Duration::from_secs(3), queued).await???;
            }
            if outcome.is_ok() {
                let mut snapshot = storage.snapshot(0).await?;
                if mode == "append" {
                    let record = snapshot.next_record()?.context("Late append was lost")?;
                    ensure!(
                        matches!(record.data, RecordData::Output { ref data } if data == "READY")
                            && record.sequence == 1,
                        "Unexpected committed late record"
                    );
                } else if mode == "manifest" {
                    let persisted =
                        Manifest::read(std::fs::File::open(directory.join("manifest.json"))?)?;
                    ensure!(
                        persisted.metadata == "delayed update".into(),
                        "Late manifest update was canceled"
                    );
                }
                ensure!(
                    snapshot.next_record()?.is_none(),
                    "Busy close fabricated an exit or duplicate record"
                );
                let reply = wire(&socket, "terminate", &manifest.token).await?;
                ensure!(
                    reply["type"] == "response" && reply["error"].is_null(),
                    "Authenticated close could not retry: {reply}"
                );
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        // Creator-held Handle is an ownership capability. This idempotent
        // cleanup also covers a failed wire assertion or an expired peer.
        let cleanup = tokio::time::timeout(
            Duration::from_secs(6),
            owner.command(Command::Terminate {
                token: Some(manifest.token),
            }),
        )
        .await;
        if cleanup.as_ref().is_ok_and(|reply| reply.is_ok()) {
            owner.shutdown.send_replace(true);
        }
        let stopped = tokio::time::timeout(Duration::from_secs(2), serving).await;
        cleanup.context("Owned fixture cleanup timed out")??;
        stopped.context("Fixture server did not stop")???;
        ensure!(
            !directory.exists() && !socket.exists(),
            "Successful cleanup retained storage/socket"
        );
        outcome?;
        resumed?;
    }
    Ok(())
}

#[tokio::test]
async fn admitted_stalled_deletion_retains_one_transaction_across_cancellation_and_retry(
) -> Result<()> {
    for phase in [
        crate::storage::StallPhase::Close,
        crate::storage::StallPhase::Manifest,
    ] {
        let root = tempfile::tempdir()?;
        let directory = root.path().join("session");
        std::fs::create_dir(&directory)?;
        let socket = root.path().join("control.sock");
        let manifest = Manifest {
            version: 1,
            token: "a".repeat(32),
            socket_path: socket.to_string_lossy().into_owned(),
            argv: vec!["/bin/sh".into(), "-c".into(), "IFS= read -r line".into()],
            cwd: root.path().to_string_lossy().into_owned(),
            env: BTreeMap::new(),
            cols: 80,
            rows: 24,
            metadata: "original".into(),
            journal_limit_bytes: 1024 * 1024,
        };
        atomic_json(&directory, "manifest.json", &manifest)?;
        let original = std::fs::read(directory.join("manifest.json"))?;
        let storage = Storage::start(
            directory.clone(),
            Journal::new(&directory, manifest.journal_limit_bytes)?,
        );
        let (admitted, stalled) = storage.stall_next(phase);
        if phase == crate::storage::StallPhase::Manifest {
            // Real partial deletion: payload unlink succeeds, then unlinking the
            // status directory fails. Stall its admitted discovery recovery.
            std::fs::create_dir(directory.join("status.json"))?;
            std::fs::write(directory.join("status.json/retained"), "untouched")?;
        }
        let pty = Pty::spawn(&manifest)?;
        let leader = pty.ownership.lock().unwrap().leader.clone();
        let owner = Handle::start(manifest.clone(), pty, storage.clone());
        let listener = UnixListener::bind(&socket)?;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        let serving = tokio::spawn(server::serve(
            listener,
            manifest.token.clone(),
            owner.clone(),
        ));
        let first_socket = socket.clone();
        let first_token = manifest.token.clone();
        let first =
            tokio::spawn(async move { wire(&first_socket, "terminate", &first_token).await });
        let outcome = async {
            tokio::time::timeout(Duration::from_secs(3), admitted).await??;
            // The authenticated request reached the actual delete worker. Cancel
            // its peer now; dropping that caller must not abandon or repeat close.
            first.abort();
            let mut status = owner.status.clone();
            tokio::time::timeout(Duration::from_secs(3), async {
                while !status.borrow_and_update().incomplete {
                    status.changed().await?;
                }
                Ok::<_, anyhow::Error>(())
            })
            .await
            .context("Admitted deletion stranded the owner")??;
            let stopped = process::identity(leader.pid)?;
            ensure!(stopped.is_none_or(|row| row.birth != leader.birth));
            let wrong = wire(&socket, "terminate", &"b".repeat(32)).await?;
            ensure!(wrong["type"] == "response" && wrong["error"].is_string());
            let started = Instant::now();
            let reply = wire(&socket, "terminate", &manifest.token).await?;
            ensure!(started.elapsed() < Duration::from_secs(3));
            ensure!(
            reply["type"] == "fault"
                && reply["message"]
                    .as_str()
                    .is_some_and(|message| message.contains("storage close is still in flight")),
            "Pending deletion falsely completed: {reply}"
        );
            let inspected = wire(&socket, "inspect", &manifest.token).await?;
            ensure!(
                inspected["status"]["incomplete"] == true
                    && inspected["status"]["sequence"] == 0
                    && inspected["status"]["exitCode"].is_null(),
                "Invalid pending-close fence: {inspected}"
            );
            let metadata = tokio::time::timeout(
                Duration::from_millis(500),
                owner.command(Command::Metadata {
                    metadata: "must not commit".into(),
                }),
            )
            .await?;
            ensure!(
                metadata.is_err(),
                "Storage mutation admitted during deletion"
            );
            ensure!(std::fs::read(directory.join("manifest.json"))? == original);
            if phase == crate::storage::StallPhase::Close {
                ensure!(std::fs::metadata(directory.join("journal.jsonl"))?.len() == 0);
            } else {
                ensure!(!directory.join("journal.jsonl").exists());
                ensure!(
                    std::fs::read_to_string(directory.join("status.json/retained"))? == "untouched"
                );
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        // Release/reap only our own fixture even on a failed assertion. There are
        // no production environment hooks and no cached-PID cleanup signals.
        first.abort();
        drop(stalled);
        let resumed = async {
            if outcome.is_ok() && phase == crate::storage::StallPhase::Close {
                tokio::time::timeout(Duration::from_secs(3), async {
                    while directory.exists() {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await?;
                // Prove retry consumes the SAME completed transaction, not a new
                // delete against a path that now names different fixture storage.
                std::fs::create_dir(&directory)?;
                std::fs::write(directory.join("replacement"), "untouched")?;
                let reply = wire(&socket, "terminate", &manifest.token).await?;
                ensure!(
                    reply["type"] == "response" && reply["error"].is_null(),
                    "Close retry failed: {reply}"
                );
                ensure!(std::fs::read_to_string(directory.join("replacement"))? == "untouched");
                ensure!(!directory.join("manifest.json").exists());
            } else if outcome.is_ok() {
                // Consume the retained failure, not another deletion. Recovery
                // commits once even though its original requesting peer vanished.
                let reply = wire(&socket, "terminate", &manifest.token).await?;
                ensure!(
                    reply["type"] == "fault" && reply["message"].is_string(),
                    "Lost close failure: {reply}"
                );
                let inspected = wire(&socket, "inspect", &manifest.token).await?;
                ensure!(
                    inspected["status"]["error"]
                        .as_str()
                        .is_some_and(|message| {
                            message.contains("close partially removed storage")
                        }),
                    "Lost typed partial-close state: {inspected}"
                );
                ensure!(std::fs::read(directory.join("manifest.json"))? == original);
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if phase == crate::storage::StallPhase::Manifest {
            std::fs::remove_dir_all(directory.join("status.json"))?;
            // A failed assertion may not yet have consumed the first transaction.
            // Consume its typed partial failure, then admit the repaired retry.
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                owner.command(Command::Terminate {
                    token: Some(manifest.token.clone()),
                }),
            )
            .await?;
        }
        let cleanup = tokio::time::timeout(
            Duration::from_secs(6),
            owner.command(Command::Terminate {
                token: Some(manifest.token),
            }),
        )
        .await;
        if cleanup.as_ref().is_ok_and(|reply| reply.is_ok()) {
            owner.shutdown.send_replace(true);
        }
        let stopped = tokio::time::timeout(Duration::from_secs(2), serving).await;
        cleanup.context("Owned deletion fixture cleanup timed out")??;
        stopped.context("Deletion fixture server did not stop")???;
        ensure!(!socket.exists());
        outcome?;
        resumed?;
    }
    Ok(())
}
