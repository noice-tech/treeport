use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
#[cfg(target_os = "linux")]
use std::os::{
    fd::{AsRawFd, FromRawFd, OwnedFd},
    unix::process::CommandExt,
};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
#[cfg(target_os = "linux")]
use treeport_session_keeper::pty;

struct BoundedChild {
    child: Arc<Mutex<Child>>,
    cancel: mpsc::Sender<()>,
    watchdog: Option<thread::JoinHandle<()>>,
}
impl BoundedChild {
    fn spawn(mut command: Command, deadline: Duration) -> Result<Self> {
        #[cfg(target_os = "linux")]
        let parent = std::process::id();
        #[cfg(target_os = "linux")]
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() as u32 != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
        let child = Arc::new(Mutex::new(command.spawn()?));
        let (cancel, canceled) = mpsc::channel();
        let owned = child.clone();
        let watchdog = thread::spawn(move || {
            if canceled.recv_timeout(deadline).is_err() {
                let mut child = owned.lock().unwrap();
                let _ = child.kill();
                let _ = child.wait();
            }
        });
        Ok(Self {
            child,
            cancel,
            watchdog: Some(watchdog),
        })
    }
    fn pid(&self) -> u32 {
        self.child.lock().unwrap().id()
    }
    fn wait(&self) -> Result<ExitStatus> {
        loop {
            if let Some(status) = self.child.lock().unwrap().try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for BoundedChild {
    fn drop(&mut self) {
        let _ = self.cancel.send(());
        let _ = self.watchdog.take().unwrap().join();
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[test]
fn watchdog_and_drop_reap_unresponsive_fixtures() -> Result<()> {
    for wait_for_watchdog in [true, false] {
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        let child = BoundedChild::spawn(command, Duration::from_millis(100))?;
        let pid = child.pid();
        if wait_for_watchdog {
            ensure!(!child.wait()?.success());
        }
        drop(child);
        ensure!(treeport_session_keeper::process::identity(pid)?.is_none());
    }
    Ok(())
}

#[test]
#[ignore = "invoked by full_pty_hangup_does_not_spin with an external watchdog"]
#[cfg(target_os = "linux")]
fn full_pty_hangup_fixture() -> Result<()> {
    ensure!(std::env::var("TREEPORT_PTY_HANGUP_FIXTURE").as_deref() == Ok("1"));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let pair = portable_pty::native_pty_system().openpty(portable_pty::PtySize::default())?;
        let raw = pair.master.as_raw_fd().context("No PTY descriptor")?;
        let duplicate = unsafe { libc::fcntl(raw, libc::F_DUPFD_CLOEXEC, 0) };
        ensure!(duplicate >= 0);
        let descriptor = unsafe { OwnedFd::from_raw_fd(duplicate) };
        let flags = unsafe { libc::fcntl(duplicate, libc::F_GETFL) };
        ensure!(flags >= 0);
        ensure!(unsafe { libc::fcntl(duplicate, libc::F_SETFL, flags | libc::O_NONBLOCK) } == 0);
        let descriptor = tokio::io::unix::AsyncFd::new(descriptor)?;
        let slave = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(pair.master.tty_name().context("No slave path")?)?;
        let mut termios = unsafe { std::mem::zeroed() };
        ensure!(unsafe { libc::tcgetattr(slave.as_raw_fd(), &mut termios) } == 0);
        unsafe { libc::cfmakeraw(&mut termios) };
        ensure!(unsafe { libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &termios) } == 0);
        let bytes = [b'x'; 8192];
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            ensure!(Instant::now() < deadline, "PTY input did not fill");
            let count = unsafe { libc::write(duplicate, bytes.as_ptr().cast(), bytes.len()) };
            if count < 0 {
                ensure!(std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock);
                break;
            }
        }
        drop(slave);
        drop(pair.slave);
        let mut poll = libc::pollfd {
            fd: duplicate,
            events: libc::POLLOUT,
            revents: 0,
        };
        ensure!(unsafe { libc::poll(&mut poll, 1, 0) } == 1);
        ensure!(poll.revents & libc::POLLHUP != 0);
        loop {
            ensure!(Instant::now() < deadline, "Hung-up PTY input did not fill");
            let count = unsafe { libc::write(duplicate, bytes.as_ptr().cast(), bytes.len()) };
            if count < 0 {
                ensure!(std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock);
                break;
            }
        }
        let error = pty::write(&descriptor, &bytes).await.unwrap_err();
        ensure!(error.kind() == std::io::ErrorKind::BrokenPipe);
        Ok(())
    })
}

#[test]
#[cfg(target_os = "linux")]
fn full_pty_hangup_does_not_spin() -> Result<()> {
    let mut command = Command::new(std::env::current_exe()?);
    command.args([
        "--exact",
        "full_pty_hangup_fixture",
        "--ignored",
        "--nocapture",
    ]);
    command.env("TREEPORT_PTY_HANGUP_FIXTURE", "1");
    let child = BoundedChild::spawn(command, Duration::from_secs(3))?;
    ensure!(
        child.wait()?.success(),
        "Hung-up PTY write stalled or failed (fixture reaped)"
    );
    Ok(())
}

fn send(socket: &mut UnixStream, request: Value) -> Result<()> {
    writeln!(socket, "{request}")?;
    Ok(())
}
fn receive(socket: &mut BufReader<UnixStream>) -> Result<Value> {
    let mut line = String::new();
    ensure!(socket.read_line(&mut line)? > 0, "Keeper disconnected");
    Ok(serde_json::from_str(&line)?)
}
fn connect(path: &std::path::Path) -> Result<UnixStream> {
    let socket = UnixStream::connect(path)?;
    socket.set_read_timeout(Some(Duration::from_secs(1)))?;
    socket.set_write_timeout(Some(Duration::from_secs(1)))?;
    Ok(socket)
}
#[cfg(target_os = "linux")]
fn cpu_ticks(pid: u32) -> Result<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let (_, fields) = stat.rsplit_once(')').context("Missing stat fields")?;
    let fields: Vec<_> = fields.split_whitespace().collect();
    Ok(fields[11].parse::<u64>()? + fields[12].parse::<u64>()?)
}

#[test]
fn backpressured_keeper_handles_close_and_natural_exit_without_idle_spin() -> Result<()> {
    for natural_exit in [false, true] {
        let root = tempfile::Builder::new()
            .prefix("tp-pty-")
            .tempdir_in("/tmp")?;
        let directory = root.path().join("session");
        std::fs::create_dir(&directory)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        let socket_path = root.path().join("control.sock");
        let token = "a".repeat(32);
        std::fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&json!({
                "version": 1, "token": token, "socketPath": socket_path,
                "argv": ["/bin/sh", "-c", "stty raw -echo; printf READY; for n in 1 2 3 4 5 6 7 8 9 10; do sleep 0.1; printf 'TICK:%s\\n' \"$n\"; done; printf TAIL"],
                "cwd": root.path(), "env": {"PATH": "/usr/bin:/bin"},
                "cols": 80, "rows": 24, "metadata": "{}", "journalLimitBytes": 1048576
            }))?,
        )?;
        let mut command = Command::new(env!("CARGO_BIN_EXE_treeport-session-keeper"));
        command.arg(&directory).stdin(Stdio::null());
        let child = BoundedChild::spawn(command, Duration::from_secs(8))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while !directory.join("status.json").exists() {
            ensure!(Instant::now() < deadline, "Keeper startup timed out");
            thread::sleep(Duration::from_millis(10));
        }
        let mut attached = BufReader::new(connect(&socket_path)?);
        send(
            attached.get_mut(),
            json!({"method":"attach", "id":"attach", "token":token}),
        )?;
        let mut output = String::new();
        loop {
            let frame = receive(&mut attached)?;
            if frame["type"] == "output" {
                output.push_str(frame["data"].as_str().context("Missing output")?);
            }
            if frame["type"] == "ready" {
                break;
            }
        }
        send(
            attached.get_mut(),
            json!({"method":"pause", "id":"live", "paused":false}),
        )?;
        while !output.contains("READY") {
            let frame = receive(&mut attached)?;
            if frame["type"] == "output" {
                output.push_str(frame["data"].as_str().context("Missing output")?);
            }
        }
        for index in 0..4 {
            send(
                attached.get_mut(),
                json!({"method":"write", "id":format!("input-{index}"), "data":"x".repeat(512*1024), "encoding":"utf8"}),
            )?;
        }
        let mut admitted = false;
        while !admitted || !output.contains("TICK:2") {
            let frame = receive(&mut attached)?;
            if frame["type"] == "output" {
                output.push_str(frame["data"].as_str().context("Missing output")?);
            }
            if frame["id"] == "input-2" {
                ensure!(frame["error"].is_null());
                admitted = true;
            }
        }
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let mut peer = BufReader::new(connect(&socket_path)?);
            send(
                peer.get_mut(),
                json!({"method":"inspect", "id":"inspect", "token":token}),
            )?;
            let frame = receive(&mut peer)?;
            ensure!(frame["error"].is_null() && frame["status"]["error"].is_null());
            if !natural_exit || frame["status"]["exitCode"] == 0 {
                break;
            }
            ensure!(Instant::now() < deadline, "Natural exit was not recorded");
            thread::sleep(Duration::from_millis(20));
        }
        #[cfg(target_os = "linux")]
        {
            let before = cpu_ticks(child.pid())?;
            thread::sleep(Duration::from_millis(300));
            let ticks = cpu_ticks(child.pid())? - before;
            let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as u64;
            ensure!(ticks <= hz / 10, "Idle keeper consumed {ticks} CPU ticks");
        }
        if natural_exit {
            loop {
                let frame = receive(&mut attached)?;
                if frame["type"] == "output" {
                    output.push_str(frame["data"].as_str().context("Missing output")?);
                }
                if frame["type"] == "exit" {
                    ensure!(frame["exitCode"] == 0 && output.ends_with("TAIL"));
                    break;
                }
            }
        }
        let mut peer = BufReader::new(connect(&socket_path)?);
        send(
            peer.get_mut(),
            json!({"method":"terminate", "id":"close", "token":token}),
        )?;
        let frame = receive(&mut peer)?;
        ensure!(frame["type"] == "response" && frame["error"].is_null());
        ensure!(child.wait()?.success(), "Keeper did not exit after close");
        ensure!(!directory.exists() && !socket_path.exists());
    }
    Ok(())
}
