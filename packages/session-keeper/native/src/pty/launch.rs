use crate::{
    process::{self, Identity, Ownership},
    protocol::Manifest,
};
use anyhow::{bail, ensure, Context, Result};
use portable_pty::CommandBuilder;
use std::{
    io::{self, Read},
    os::{fd::AsRawFd, unix::net::UnixStream, unix::process::CommandExt},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;

pub(super) struct Gate {
    parent: Arc<UnixStream>,
    allowed: bool,
}
impl Gate {
    pub(super) fn allow(&mut self) -> Result<()> {
        // A single nonblocking byte is the only command-start authority. No
        // user code runs on EOF, timeout, a denied byte, or a failed send.
        let byte = [1_u8];
        // SAFETY: parent owns this socket and byte is readable for its length.
        let sent = unsafe {
            libc::send(
                self.parent.as_raw_fd(),
                byte.as_ptr().cast(),
                byte.len(),
                libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
            )
        };
        if sent != 1 {
            return Err(io::Error::last_os_error()).context("Cannot release owned PTY command");
        }
        self.allowed = true;
        Ok(())
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        if !self.allowed {
            let byte = [0_u8];
            // SAFETY: this owned socket remains live through send. Never block
            // unwinding or raise SIGPIPE if the pre-exec child already exited.
            unsafe {
                libc::send(
                    self.parent.as_raw_fd(),
                    byte.as_ptr().cast(),
                    byte.len(),
                    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
                );
            }
        }
    }
}

pub(super) struct Held {
    pub pid: u32,
    pub ownership: Arc<Mutex<Ownership>>,
    pub exit: oneshot::Receiver<Result<i32>>,
    pub reap: std::sync::mpsc::SyncSender<()>,
    pub gate: Gate,
}

// portable-pty exposes no pre-exec hook. Keep its PTY allocation/resize, but
// launch with std's fork/exec boundary so identity acquisition precedes exec.
// The worker owns/reaps its Child even if identity setup or the caller fails.
pub(super) fn hold(
    manifest: &Manifest,
    slave: std::fs::File,
    identify: impl FnOnce(u32) -> Result<Option<Identity>>,
) -> Result<Held> {
    let mut builder = CommandBuilder::new(&manifest.argv[0]);
    builder.env_clear();
    for (key, value) in &manifest.env {
        builder.env(key, value);
    }
    let program = std::path::Path::new(&manifest.argv[0]);
    let program = if program.is_relative() && manifest.argv[0].contains('/') {
        std::env::current_dir()?.join(&manifest.cwd).join(program)
    } else {
        program.to_path_buf()
    };
    let mut command = std::process::Command::new(program);
    command
        .arg0(&manifest.argv[0])
        .args(&manifest.argv[1..])
        .current_dir(&manifest.cwd)
        .env_clear()
        .env("SHELL", builder.get_shell())
        .envs(&manifest.env)
        .env("TERM", "xterm-256color")
        .stdin(slave.try_clone()?)
        .stdout(slave.try_clone()?)
        .stderr(slave);
    let (parent, child_gate) = UnixStream::pair()?;
    let deadline = Some(Duration::from_secs(3));
    parent.set_read_timeout(deadline)?;
    child_gate.set_read_timeout(deadline)?;
    child_gate.set_write_timeout(deadline)?;
    let parent = Arc::new(parent);
    let gate = Gate {
        parent: parent.clone(),
        allowed: false,
    };
    let child_parent = parent.clone();
    // SAFETY: after fork, this closure only uses async-signal-safe syscalls,
    // stack data, and reads of already-owned descriptors. No allocation,
    // locking, filesystem enumeration, Rust destructors, or user code.
    unsafe {
        command.pre_exec(move || {
            // These captures pin both fd numbers in the spawning parent until
            // fork completes. Close the child's copy of the opposite endpoint
            // so parent death cannot keep the child's gate alive accidentally.
            libc::close(child_parent.as_raw_fd());
            for signal in [
                libc::SIGCHLD,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGALRM,
            ] {
                if libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR {
                    return Err(io::Error::last_os_error());
                }
            }
            let mut empty: libc::sigset_t = std::mem::zeroed();
            if libc::sigemptyset(&mut empty) != 0
                || libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut()) != 0
                || libc::setsid() < 0
                || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0
            {
                return Err(io::Error::last_os_error());
            }
            let pid = (libc::getpid() as u32).to_ne_bytes();
            let mut offset = 0;
            while offset < pid.len() {
                let sent = libc::send(
                    child_gate.as_raw_fd(),
                    pid[offset..].as_ptr().cast(),
                    pid.len() - offset,
                    libc::MSG_NOSIGNAL,
                );
                if sent < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                if sent == 0 {
                    return Err(io::Error::from_raw_os_error(libc::ECANCELED));
                }
                offset += sent as usize;
            }
            let mut byte = [0_u8];
            loop {
                let count = libc::recv(child_gate.as_raw_fd(), byte.as_mut_ptr().cast(), 1, 0);
                if count < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                return if count == 1 && byte[0] == 1 {
                    Ok(())
                } else {
                    Err(io::Error::from_raw_os_error(libc::ECANCELED))
                };
            }
        });
    }
    let (owned, ownership_receiver) = std::sync::mpsc::sync_channel::<Arc<Mutex<Ownership>>>(1);
    let (sender, exit) = oneshot::channel();
    let (launched, launch_result) = std::sync::mpsc::sync_channel(1);
    let (reap, reaper) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("pty-launch-and-wait".into())
        .spawn(move || {
            let mut sender = Some(sender);
            let result = (|| -> Result<i32> {
                let spawned = command.spawn();
                // Report std's spawn/pre-exec errno before dropping the gate
                // endpoint makes the admission reader observe EOF. Otherwise a
                // failed chdir, fork or TIOCSCTTY is hidden by a short read.
                let _ = launched.send(
                    spawned.as_ref().map(|_| ()).map_err(|error| {
                        io::Error::new(error.kind(), error.to_string())
                    }),
                );
                // The parent's copies of the child gate and stdio must not
                // hold EOF open while waiting on the command's lifetime.
                drop(command);
                let mut child = spawned.context("Cannot execute owned PTY command")?;
                let owned = match ownership_receiver.recv() {
                    Ok(owned) => owned,
                    Err(_) => {
                        // A child killed before exec can close std's error pipe
                        // and make spawn report success. Still reap that exact
                        // Child; dropping Child alone would leave a zombie.
                        let _ = child.wait();
                        bail!("PTY launch canceled before ownership admission");
                    }
                };
                let pid = child.id();
                ensure!(owned.lock().unwrap().leader.pid == pid, "PTY launch identity changed");
                // Keep the zombie as an exact-child kernel anchor until all
                // surviving original-session descendants have been recorded.
                // SAFETY: initialized info is written only by waitid for our
                // unreaped Child, without releasing its PID/birth anchor.
                let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                loop {
                    if unsafe {
                        libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT)
                    } == 0
                    {
                        break;
                    }
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(error.into());
                    }
                }
                // SAFETY: successful waitid initialized this SIGCHLD record.
                if unsafe { info.si_pid() } != pid as libc::pid_t
                    || !matches!(info.si_code, libc::CLD_EXITED | libc::CLD_KILLED | libc::CLD_DUMPED)
                {
                    bail!("Cannot validate observed PTY exit record");
                }
                owned.lock().unwrap().leader_exit_pinned = true;
                let discovery = process::snapshot()
                    .and_then(|table| owned.lock().unwrap().discover(&table).map(|_| ()));
                if let Err(error) = discovery {
                    crate::diagnostics::report(format!(
                        "Cannot retain exited session descendants: {error:#}; retaining unreaped leader until cleanup"
                    ));
                    // SAFETY: si_status is read only for validated CLD_EXITED.
                    let code = if info.si_code == libc::CLD_EXITED {
                        unsafe { info.si_status() }
                    } else {
                        0
                    };
                    let _ = sender.take().unwrap().send(Ok(code));
                    let _ = reaper.recv();
                }
                // Reaping and pin release share discovery's lock; cleanup must
                // not borrow a leader pin after the kernel reuses its PID.
                let status = {
                    let mut ownership = owned.lock().unwrap();
                    let result = child.wait();
                    ownership.leader_exit_pinned = false;
                    result?
                };
                // v1/node-pty records signal death as exitCode zero.
                Ok(status.code().unwrap_or(0))
            })();
            if let Some(sender) = sender {
                let _ = sender.send(result);
            } else if let Err(error) = result {
                crate::diagnostics::report(format!("Cannot reap retained PTY leader: {error:#}"));
            }
        })?;
    let mut bytes = [0; 4];
    if let Err(error) = (&*parent).read_exact(&mut bytes) {
        // Deny admission before waiting for spawn to finish. A timed-out child
        // may still be waiting on its gate; never wait for it while holding the
        // only cancellation authority. Bound this diagnostic wait too.
        drop(gate);
        drop(owned);
        if let Ok(Err(spawn_error)) = launch_result.recv_timeout(Duration::from_secs(3)) {
            return Err(spawn_error).context("Cannot spawn PTY command before ownership admission");
        }
        return Err(error).context("PTY launch ended before ownership admission");
    }
    let pid = u32::from_ne_bytes(bytes);
    let leader = identify(pid)?.context("Cannot identify held PTY leader")?;
    ensure!(
        leader.pid == pid && leader.birth > 0 && !leader.zombie,
        "Invalid held PTY identity"
    );
    let ownership = Arc::new(Mutex::new(Ownership::new(leader)?));
    owned.try_send(ownership.clone())?;
    Ok(Held {
        pid,
        ownership,
        exit,
        reap,
        gate,
    })
}
