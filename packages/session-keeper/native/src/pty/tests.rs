use super::*;
use anyhow::{bail, ensure};
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt, time::Duration};

fn manifest(root: &std::path::Path) -> Manifest {
    Manifest {
        version: 1,
        ownership: Some("lease-v1".into()),
        token: "a".repeat(32),
        socket_path: root.join("control.sock").to_string_lossy().into_owned(),
        argv: vec![
            "/bin/sh".into(),
            "-c".into(),
            "printf started >command-started; (printf forked >descendant-started; sleep 1) & wait"
                .into(),
        ],
        cwd: root.to_string_lossy().into_owned(),
        env: BTreeMap::new(),
        cols: 80,
        rows: 24,
        metadata: "{}".into(),
        journal_limit_bytes: 1024 * 1024,
    }
}

async fn gone(original: &process::Identity) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(4), async {
        while process::identity(original.pid)?.is_some_and(|row| row.birth == original.birth) {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("Owned launch was not reaped")?
}

#[tokio::test]
async fn rejected_ownership_cannot_execute_or_fork_and_always_reaps_the_child() -> Result<()> {
    for fault in [
        "error", "missing", "zero", "pid", "parent", "group", "session", "zombie",
    ] {
        let root = tempfile::tempdir()?;
        let mut original = None;
        let mut executed_before_identity = false;
        let started = root.path().join("command-started");
        let descendant = root.path().join("descendant-started");
        let result = Pty::spawn_identified(&manifest(root.path()), |pid| {
            let mut row = process::identity(pid)?.context("Held leader absent")?;
            original = Some(row.clone());
            std::thread::sleep(Duration::from_millis(30));
            executed_before_identity = started.exists() || descendant.exists();
            match fault {
                "error" => bail!("Injected identity acquisition failure"),
                "missing" => return Ok(None),
                "zero" => row.birth = 0,
                "pid" => row.pid += 1,
                "parent" => row.parent = 1,
                "group" => row.group = 1,
                "session" => row.session = 1,
                "zombie" => row.zombie = true,
                _ => unreachable!(),
            }
            Ok(Some(row))
        });
        let original = original.context("Identity probe did not run")?;
        gone(&original).await?;
        ensure!(result.is_err(), "{fault}: invalid ownership admitted");
        ensure!(
            !executed_before_identity,
            "{fault}: user code preceded identity"
        );
        ensure!(
            !started.exists() && !descendant.exists(),
            "{fault}: rejected command ran"
        );
    }
    Ok(())
}

#[tokio::test]
async fn dropping_an_unreleased_launch_denies_exec_and_reaps_without_hangup() -> Result<()> {
    let root = tempfile::tempdir()?;
    let manifest = manifest(root.path());
    let pair = native_pty_system().openpty(PtySize::default())?;
    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NOCTTY | libc::O_CLOEXEC)
        .open(pair.master.tty_name().context("Missing owned slave")?)?;
    let held = launch::hold(&manifest, slave, process::identity)?;
    let original = held.ownership.lock().unwrap().leader.clone();
    std::thread::sleep(Duration::from_millis(30));
    let before = root.path().join("command-started").exists();
    let canceled = std::time::Instant::now();
    drop(held);
    gone(&original).await?;
    ensure!(
        canceled.elapsed() < Duration::from_secs(1),
        "Cancellation waited for the three-second child deadline"
    );
    ensure!(!before && !root.path().join("command-started").exists());
    ensure!(!root.path().join("descendant-started").exists());
    drop(pair);
    Ok(())
}

#[test]
#[ignore = "subprocess-only startup fault fixture"]
fn parent_exit_fixture() -> Result<()> {
    let root = std::path::PathBuf::from(std::env::var("TREEPORT_TEST_GATE_DIRECTORY")?);
    let pair = native_pty_system().openpty(PtySize::default())?;
    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NOCTTY | libc::O_CLOEXEC)
        .open(pair.master.tty_name().context("Missing owned slave")?)?;
    let held = launch::hold(&manifest(&root), slave, process::identity)?;
    let original = held.ownership.lock().unwrap().leader.clone();
    std::fs::write(
        root.join("held-identity"),
        format!("{} {} {}", original.pid, original.birth, std::process::id()),
    )?;
    std::process::exit(0);
}

#[tokio::test]
async fn actual_parent_exit_denies_exec_before_the_child_deadline() -> Result<()> {
    let root = tempfile::tempdir()?;
    let result = std::process::Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "pty::tests::parent_exit_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("TREEPORT_TEST_GATE_DIRECTORY", root.path())
        .spawn()?;
    let parent = result.id();
    let status = {
        let mut result = result;
        result.wait()?
    };
    let ended = std::time::Instant::now();
    let evidence = std::fs::read_to_string(root.path().join("held-identity"))?;
    let fields = evidence.split_whitespace().collect::<Vec<_>>();
    ensure!(fields.len() == 3 && fields[2].parse::<u32>()? == parent);
    let original = process::Identity {
        pid: fields[0].parse()?,
        birth: fields[1].parse()?,
        parent,
        group: 0,
        session: 0,
        zombie: false,
        name: String::new(),
    };
    gone(&original).await?;
    ensure!(status.success());
    ensure!(
        ended.elapsed() < Duration::from_secs(1),
        "Parent death waited for the child deadline"
    );
    ensure!(!root.path().join("command-started").exists());
    ensure!(!root.path().join("descendant-started").exists());
    Ok(())
}

#[tokio::test]
async fn verified_launch_preserves_relative_path_cwd_environment_and_exit() -> Result<()> {
    for program in ["./command", "command"] {
        let root = tempfile::tempdir()?;
        let file = root.path().join("command");
        std::fs::write(
            &file,
            "#!/bin/sh\nprintf '%s|%s|%s' \"$PWD\" \"$TERM\" \"$OWNED\"; exit 7\n",
        )?;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700))?;
        let mut manifest = manifest(root.path());
        manifest.argv = vec![program.into()];
        manifest.env = BTreeMap::from([
            ("PATH".into(), ".".into()),
            ("OWNED".into(), "workspace".into()),
        ]);
        let mut pty = Pty::spawn(&manifest)?;
        let original = pty.ownership.lock().unwrap().leader.clone();
        let result = tokio::time::timeout(Duration::from_secs(4), async {
            let mut text = String::new();
            while let Some(capture) = pty.capture.recv().await {
                match capture {
                    Capture::Output(data) => text.push_str(&data),
                    Capture::Eof => break,
                    Capture::Error(error) => bail!("{error}"),
                }
            }
            let code = (&mut pty.exit).await??;
            Ok::<_, anyhow::Error>((text, code))
        })
        .await
        .context("Owned command did not finish")??;
        gone(&original).await?;
        ensure!(result.1 == 7);
        let cwd = std::fs::canonicalize(root.path())?;
        ensure!(
            result.0 == format!("{}|xterm-256color|workspace", cwd.display()),
            "Unexpected command environment: {:?}",
            result.0
        );
    }
    Ok(())
}
