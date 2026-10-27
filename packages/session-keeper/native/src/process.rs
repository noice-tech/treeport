use anyhow::{bail, Context, Result};
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Identity {
    pub pid: u32,
    pub parent: u32,
    pub group: u32,
    pub session: u32,
    pub birth: u128,
    pub zombie: bool,
    pub name: String,
}
pub type Snapshot = BTreeMap<u32, Identity>;

#[cfg(target_os = "macos")]
#[repr(C)]
struct AuditToken {
    values: [u32; 8],
}
#[cfg(target_os = "macos")]
extern "C" {
    static mach_task_self_: u32;
    fn task_name_for_pid(task: u32, pid: i32, name: *mut u32) -> i32;
    fn task_info(task: u32, flavor: u32, info: *mut i32, count: *mut u32) -> i32;
    fn mach_port_deallocate(task: u32, name: u32) -> i32;
    fn proc_signal_with_audittoken(token: *mut AuditToken, signal: i32) -> i32;
}

const MAX_PROCESSES: usize = 65_536;

#[cfg(target_os = "macos")]
fn macos_pids(enumerate: impl FnOnce(&mut [libc::pid_t]) -> io::Result<usize>) -> Result<Vec<u32>> {
    // One extra slot distinguishes an exactly-full table from a truncated kernel result.
    let mut buffer = vec![0; MAX_PROCESSES + 1];
    let bytes = enumerate(&mut buffer)?;
    let width = std::mem::size_of::<libc::pid_t>();
    if bytes == 0 || bytes % width != 0 || bytes > buffer.len() * width {
        bail!("Invalid native process enumeration result");
    }
    let count = bytes / width;
    if count > MAX_PROCESSES {
        bail!("Process enumeration exceeds the process limit");
    }
    buffer.truncate(count);
    let mut seen = BTreeSet::new();
    for pid in buffer {
        // PID zero is the kernel, not a userspace terminal descendant. getsid(0)
        // would refer to this keeper, rather than identifying that list entry.
        if pid == 0 {
            continue;
        }
        if pid < 0 || !seen.insert(pid as u32) {
            bail!("Invalid or duplicate native process identifier");
        }
    }
    Ok(seen.into_iter().collect())
}

#[cfg(target_os = "macos")]
pub fn identity(pid: u32) -> Result<Option<Identity>> {
    // SAFETY: proc_pidinfo writes at most the provided initialized struct size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if read != size {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        if read == 0 {
            return Err(error).with_context(|| format!("Cannot identify process {pid}"));
        }
        bail!("Cannot identify process {pid}: proc_pidinfo returned a partial record ({read})");
    }
    // getsid is a separate syscall; verify that proc_pidinfo still identifies
    // the same birth afterward rather than attaching another PID's session.
    let session = unsafe { libc::getsid(pid as libc::pid_t) };
    if session < 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        return Err(error).context("Cannot identify process session");
    }
    let mut verified: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut verified as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if read != size {
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        bail!("Cannot revalidate process {pid} after getsid ({read} bytes): {error}");
    }
    if (verified.pbi_start_tvsec, verified.pbi_start_tvusec)
        != (info.pbi_start_tvsec, info.pbi_start_tvusec)
    {
        bail!("Process {pid} identity changed while discovering its session");
    }
    let bytes: Vec<u8> = info
        .pbi_comm
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    Ok(Some(Identity {
        pid: info.pbi_pid,
        parent: info.pbi_ppid,
        group: info.pbi_pgid,
        session: session as u32,
        birth: info.pbi_start_tvsec as u128 * 1_000_000 + info.pbi_start_tvusec as u128,
        zombie: info.pbi_status == libc::SZOMB,
        name: String::from_utf8_lossy(&bytes).into_owned(),
    }))
}

/// Best-effort argument vector of a live process; empty when it cannot be read.
#[cfg(target_os = "linux")]
pub fn arguments(pid: u32) -> Vec<String> {
    let Ok(bytes) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return Vec::new();
    };
    split_arguments(bytes.strip_suffix(&[0]).unwrap_or(&bytes), usize::MAX)
}

#[cfg(target_os = "macos")]
pub fn arguments(pid: u32) -> Vec<String> {
    let mut maximum: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: sysctl writes at most `size` bytes into the initialized integer.
    if unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&mut maximum as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || maximum <= 0
    {
        return Vec::new();
    }
    let mut buffer = vec![0u8; maximum as usize];
    let mut size = buffer.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    // SAFETY: sysctl writes at most `size` bytes into the allocated buffer.
    if unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || size < 4
    {
        return Vec::new();
    }
    // KERN_PROCARGS2 is argc, the executable path, NUL padding, then argv.
    let count = i32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]).max(0) as usize;
    let rest = &buffer[4..size];
    let path = rest
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(rest.len());
    let rest = &rest[path..];
    let start = rest
        .iter()
        .position(|byte| *byte != 0)
        .unwrap_or(rest.len());
    split_arguments(&rest[start..], count)
}

fn split_arguments(bytes: &[u8], count: usize) -> Vec<String> {
    if bytes.is_empty() {
        return Vec::new();
    }
    bytes
        .split(|byte| *byte == 0)
        .take(count)
        .map(|argument| String::from_utf8_lossy(argument).into_owned())
        .collect()
}

#[cfg(target_os = "linux")]
pub fn identity(pid: u32) -> Result<Option<Identity>> {
    let path = format!("/proc/{pid}/stat");
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        // A process reaped after open but before read makes procfs return
        // ESRCH rather than ENOENT.
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error).context("Cannot read process birth identity"),
    };
    parse_stat(&bytes).map(Some)
}

#[cfg(target_os = "linux")]
fn parse_stat(bytes: &[u8]) -> Result<Identity> {
    // comm can contain whitespace and ')' (even newlines); split at the last
    // closing parenthesis, not at a fixed whitespace field or the first ')'.
    let open = bytes
        .iter()
        .position(|b| *b == b'(')
        .context("Invalid /proc stat")?;
    let close = bytes
        .iter()
        .rposition(|b| *b == b')')
        .context("Invalid /proc stat")?;
    if close <= open {
        bail!("Invalid /proc comm");
    }
    let pid: u32 = std::str::from_utf8(&bytes[..open])?.trim().parse()?;
    let fields: Vec<&str> = std::str::from_utf8(&bytes[close + 1..])?
        .split_whitespace()
        .collect();
    if fields.len() < 20 {
        bail!("Truncated /proc stat");
    }
    Ok(Identity {
        pid,
        parent: fields[1].parse()?,
        group: fields[2].parse()?,
        session: fields[3].parse()?,
        birth: fields[19].parse()?,
        zombie: fields[0] == "Z",
        name: String::from_utf8_lossy(&bytes[open + 1..close]).into_owned(),
    })
}

pub fn snapshot() -> Result<Snapshot> {
    let mut result = BTreeMap::new();
    #[cfg(target_os = "macos")]
    {
        let pids = macos_pids(|buffer| {
            // SAFETY: proc_listpids receives a live initialized pid_t buffer of
            // the stated byte length. PROC_ALL_PIDS (1) returns bytes, not rows.
            let bytes = unsafe {
                libc::proc_listpids(
                    1,
                    0,
                    buffer.as_mut_ptr().cast(),
                    std::mem::size_of_val(buffer) as libc::c_int,
                )
            };
            if bytes <= 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(bytes as usize)
        })?;
        // SIP denies proc_pidinfo for some system processes.
        for pid in pids {
            let row = match identity(pid) {
                Ok(Some(row)) => row,
                Ok(None) => continue,
                Err(error) => {
                    let permission_denied = error
                        .downcast_ref::<io::Error>()
                        .is_some_and(|cause| cause.kind() == io::ErrorKind::PermissionDenied);
                    if !permission_denied {
                        return Err(error);
                    }
                    let session = unsafe { libc::getsid(pid as libc::pid_t) };
                    if session < 0 {
                        let error = io::Error::last_os_error();
                        if error.raw_os_error() == Some(libc::ESRCH) {
                            continue;
                        }
                        return Err(error).context("Cannot identify opaque process session");
                    }
                    Identity {
                        pid,
                        parent: 0,
                        group: 0,
                        session: session as u32,
                        birth: 0,
                        zombie: false,
                        name: String::new(),
                    }
                }
            };
            result.insert(pid, row);
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut count = 0;
        for entry in std::fs::read_dir("/proc")? {
            let name = entry?.file_name();
            let Some(pid) = name.to_str().and_then(|name| name.parse::<u32>().ok()) else {
                continue;
            };
            count += 1;
            if count > MAX_PROCESSES {
                bail!("Process enumeration exceeds the process limit");
            }
            if let Some(row) = identity(pid)? {
                result.insert(pid, row);
            }
        }
    }
    if !result.contains_key(&std::process::id()) {
        bail!("Process enumeration did not identify the session keeper");
    }
    Ok(result)
}

pub struct Ownership {
    pub leader: Identity,
    pub targets: BTreeMap<u32, Identity>,
    pub leader_exit_pinned: bool,
}
impl Ownership {
    pub fn new(leader: Identity) -> Result<Self> {
        if leader.parent != std::process::id()
            || leader.group != leader.pid
            || leader.session != leader.pid
        {
            bail!("PTY leader is not owned by this keeper");
        }
        let targets = BTreeMap::from([(leader.pid, leader.clone())]);
        Ok(Self {
            leader,
            targets,
            leader_exit_pinned: false,
        })
    }

    pub fn discover(&mut self, table: &Snapshot) -> Result<Vec<Identity>> {
        if let Some(current) = table.get(&self.leader.pid) {
            if current.birth != self.leader.birth || current.parent != self.leader.parent {
                bail!("PTY leader PID no longer identifies this session; refusing cleanup");
            }
        }
        let members: Vec<&Identity> = table
            .values()
            .filter(|row| row.session == self.leader.session && !row.zombie)
            .collect();
        let anchored = self.leader_exit_pinned
            || table
                .get(&self.leader.pid)
                .is_some_and(|row| row.birth == self.leader.birth)
            || table.values().any(|row| {
                row.session == self.leader.session
                    && self
                        .targets
                        .get(&row.pid)
                        .is_some_and(|old| old.birth == row.birth)
            });
        if !members.is_empty() && !anchored {
            bail!("Terminal session has no verified member; refusing cleanup");
        }
        let mut children: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
        for row in table.values() {
            children.entry(row.parent).or_default().push(row.pid);
        }
        let mut remaining: Vec<u32> = self
            .targets
            .values()
            .filter(|old| {
                table
                    .get(&old.pid)
                    .is_some_and(|row| old.birth == row.birth && row.session == self.leader.session)
            })
            .map(|row| row.pid)
            .chain(members.iter().map(|row| row.pid))
            .collect();
        let mut seen = BTreeSet::new();
        let mut live = Vec::new();
        while let Some(pid) = remaining.pop() {
            if !seen.insert(pid) {
                continue;
            }
            let row = table
                .get(&pid)
                .context("Process snapshot is inconsistent")?;
            if row.session != self.leader.session {
                continue;
            }
            if row.birth == 0 {
                bail!("Cannot verify session process {pid}; refusing cleanup");
            }
            if self.targets.len() >= MAX_PROCESSES && !self.targets.contains_key(&pid) {
                bail!("Retained ownership exceeds the process limit");
            }
            self.targets.insert(pid, row.clone());
            remaining.extend(children.get(&pid).into_iter().flatten());
            if !row.zombie {
                live.push(row.clone());
            }
        }
        live.reverse();
        Ok(live)
    }
}

pub fn signal(row: &Identity, signal: i32) -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
        // pidfd pins the target through validation and signaling (Linux >=5.3).
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, row.pid as libc::pid_t, 0) } as i32;
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(error).context("Cannot pin session process for signaling");
        }
        // SAFETY: successful pidfd_open returns a newly owned descriptor.
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let current = identity(row.pid)?.context("Session process disappeared before signaling")?;
        if current.birth != row.birth {
            bail!("Session process identity changed before signaling");
        }
        if current.session != row.session {
            return Ok(());
        }
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error.into());
            }
        }
    }
    #[cfg(target_os = "macos")]
    signal_macos(row, signal, |_| {})?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn signal_macos(
    row: &Identity,
    signal: i32,
    before_delivery: impl FnOnce(&mut AuditToken),
) -> Result<()> {
    match identity(row.pid)? {
        None => return Ok(()),
        Some(current) if current.birth != row.birth => {
            bail!("Session process identity changed before signaling")
        }
        Some(current) if current.session != row.session || current.zombie => return Ok(()),
        Some(_) => {}
    }
    // SAFETY: mach_task_self_ is libSystem's initialized current-task port;
    // name is writable for one mach_port_name_t. This acquires only a name
    // right, never a task-control right or a caller-supplied Mach port.
    let task = unsafe { mach_task_self_ };
    let mut name = 0;
    let named = unsafe { task_name_for_pid(task, row.pid as i32, &mut name) };
    if named != 0 || name == 0 {
        match identity(row.pid)? {
            None => return Ok(()),
            Some(current) if current.birth != row.birth => {
                bail!("Session process identity changed before signaling")
            }
            Some(current) if current.session != row.session || current.zombie => return Ok(()),
            Some(_) => bail!(
                "Cannot obtain process name right for {} (Mach error {named})",
                row.pid
            ),
        }
    }
    let mut token = AuditToken { values: [0; 8] };
    let mut count = 8;
    // SAFETY: SDK TASK_AUDIT_TOKEN takes exactly eight initialized 32-bit
    // words. name is the acquired right; no fallible work/early return
    // intervenes before releasing it, on either task_info result.
    let audited = unsafe { task_info(name, 15, token.values.as_mut_ptr().cast(), &mut count) };
    let released = unsafe { mach_port_deallocate(task, name) };
    if audited != 0 || count != 8 || token.values[5] != row.pid {
        match identity(row.pid)? {
            None => return Ok(()),
            Some(current) if current.birth != row.birth => {
                bail!("Session process identity changed before signaling")
            }
            Some(current) if current.session != row.session || current.zombie => return Ok(()),
            Some(_) => bail!(
                "Cannot capture process audit identity for {} (Mach error {audited})",
                row.pid
            ),
        }
    }
    if released != 0 {
        bail!("Cannot release process name right (Mach error {released})");
    }
    match identity(row.pid)? {
        None => return Ok(()),
        Some(current) if current.birth != row.birth => {
            bail!("Session process identity changed before signaling")
        }
        Some(current) if current.session != row.session || current.zombie => return Ok(()),
        Some(_) => {}
    }
    before_delivery(&mut token);
    // SAFETY: token has the complete audit_token_t layout and is uniquely
    // borrowed for this call. libproc returns errno directly, not -1.
    let result = unsafe { proc_signal_with_audittoken(&mut token, signal) };
    if result != 0 {
        if result == libc::ESRCH {
            match identity(row.pid)? {
                None => return Ok(()),
                Some(current) if current.birth != row.birth => {
                    bail!("Session process identity changed before signaling")
                }
                Some(current) if current.session != row.session || current.zombie => return Ok(()),
                Some(_) => bail!("Session process audit version changed before signaling; retry"),
            }
        }
        return Err(io::Error::from_raw_os_error(result))
            .context("Cannot signal verified session process");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(pid: u32, parent: u32, group: u32, birth: u128) -> Identity {
        Identity {
            pid,
            parent,
            group,
            session: 100,
            birth,
            zombie: false,
            name: "fixture".into(),
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_pid_enumeration_refuses_saturation_and_malformed_results() -> Result<()> {
        let width = std::mem::size_of::<libc::pid_t>();
        for count in [1, MAX_PROCESSES] {
            let pids = macos_pids(|buffer| {
                assert_eq!(buffer.len(), MAX_PROCESSES + 1);
                for (index, pid) in buffer.iter_mut().take(count).enumerate() {
                    *pid = (index + 1) as libc::pid_t;
                }
                Ok(count * width)
            })?;
            assert_eq!(pids.len(), count);
        }
        for bytes in [0, 1, (MAX_PROCESSES + 1) * width, usize::MAX] {
            assert!(macos_pids(|_| Ok(bytes)).is_err());
        }
        for pids in [vec![1, 1], vec![-1]] {
            assert!(macos_pids(|buffer| {
                buffer[..pids.len()].copy_from_slice(&pids);
                Ok(pids.len() * width)
            })
            .is_err());
        }
        assert_eq!(
            macos_pids(|buffer| {
                buffer[..3].copy_from_slice(&[4, 0, 2]);
                Ok(3 * width)
            })?,
            vec![2, 4]
        );
        assert!(macos_pids(|_| Err(io::Error::from_raw_os_error(libc::ENOMEM))).is_err());
        Ok(())
    }

    #[test]
    fn opaque_original_session_rows_refuse_cleanup_even_without_topology() -> Result<()> {
        let leader = row(100, std::process::id(), 100, 1);
        let mut owner = Ownership::new(leader.clone())?;
        let opaque = row(101, 0, 0, 0);
        assert!(owner
            .discover(&BTreeMap::from([
                (100, leader.clone()),
                (101, opaque.clone())
            ]))
            .is_err());
        let unrelated = Identity {
            session: 500,
            ..opaque
        };
        assert_eq!(
            owner.discover(&BTreeMap::from([(100, leader.clone()), (101, unrelated)]))?,
            vec![leader]
        );
        Ok(())
    }

    #[test]
    fn retained_ownership_refuses_new_identities_at_its_budget() -> Result<()> {
        let leader = row(100, std::process::id(), 100, 1);
        let mut owner = Ownership::new(leader.clone())?;
        for index in 0..MAX_PROCESSES - 1 {
            let pid = 1000 + index as u32;
            owner
                .targets
                .insert(pid, row(pid, 1, pid, index as u128 + 2));
        }
        assert_eq!(
            owner.discover(&BTreeMap::from([(100, leader.clone())]))?,
            vec![leader.clone()]
        );
        let unknown = row(101, 100, 101, 9);
        assert!(owner
            .discover(&BTreeMap::from([(100, leader.clone()), (101, unknown)]))
            .unwrap_err()
            .to_string()
            .contains("process limit"));
        assert_eq!(owner.targets.len(), MAX_PROCESSES);
        assert!(!owner.targets.contains_key(&101));
        assert_eq!(owner.targets.get(&100), Some(&leader));
        Ok(())
    }

    #[test]
    fn native_snapshot_identifies_own_birth() -> Result<()> {
        let own = identity(std::process::id())?.context("Own identity missing")?;
        assert!(own.birth > 0);
        assert_eq!(snapshot()?.get(&own.pid).unwrap().birth, own.birth);
        Ok(())
    }
    #[test]
    fn discovers_separate_groups_and_remembers_reparented_targets() -> Result<()> {
        let leader = row(100, std::process::id(), 100, 1);
        let mut owner = Ownership::new(leader.clone())?;
        let background = row(101, 100, 101, 2);
        assert_eq!(
            owner.discover(&BTreeMap::from([
                (100, leader.clone()),
                (101, background.clone())
            ]))?,
            vec![leader.clone(), background.clone()]
        );
        let reparented = Identity {
            parent: 1,
            ..background
        };
        assert!(owner
            .discover(&BTreeMap::from([
                (100, row(100, std::process::id(), 100, 9)),
                (101, reparented.clone()),
            ]))
            .is_err());
        assert_eq!(
            owner.discover(&BTreeMap::from([
                (100, leader.clone()),
                (101, reparented.clone())
            ]))?,
            vec![leader, reparented.clone()]
        );
        assert_eq!(
            owner.discover(&BTreeMap::from([(101, reparented.clone())]))?,
            vec![reparented]
        );
        Ok(())
    }
    #[test]
    fn unreaped_exit_anchors_omitted_zombie_until_reaping() -> Result<()> {
        let leader = row(100, std::process::id(), 100, 1);
        let descendant = row(102, 1, 102, 3);
        let table = BTreeMap::from([(102, descendant.clone())]);
        let mut owner = Ownership::new(leader.clone())?;
        assert!(owner.discover(&table).is_err());
        owner.leader_exit_pinned = true;
        assert_eq!(owner.discover(&table)?, vec![descendant]);
        let mut reused = table.clone();
        reused.insert(100, row(100, std::process::id(), 100, 9));
        assert!(owner.discover(&reused).is_err());
        let mut unknown = Ownership::new(leader)?;
        unknown.leader_exit_pinned = true;
        unknown.leader_exit_pinned = false;
        assert!(unknown.discover(&table).is_err());
        Ok(())
    }

    #[test]
    fn refuses_reused_leader_and_unanchored_group() -> Result<()> {
        let leader = row(100, std::process::id(), 100, 1);
        let mut owner = Ownership::new(leader)?;
        assert!(owner
            .discover(&BTreeMap::from([(
                100,
                row(100, std::process::id(), 100, 9)
            )]))
            .is_err());
        assert!(owner
            .discover(&BTreeMap::from([(102, row(102, 1, 100, 3))]))
            .is_err());
        assert!(owner.discover(&BTreeMap::new())?.is_empty());
        Ok(())
    }
    #[test]
    fn zombie_leader_anchors_surviving_members_without_being_signaled() -> Result<()> {
        let leader = row(100, std::process::id(), 100, 1);
        let mut owner = Ownership::new(leader.clone())?;
        let zombie = Identity {
            zombie: true,
            ..leader
        };
        let group = row(101, 1, 100, 2);
        assert_eq!(
            owner.discover(&BTreeMap::from([(100, zombie), (101, group.clone())]))?,
            vec![group.clone()]
        );
        assert_eq!(
            owner.discover(&BTreeMap::from([(101, group.clone())]))?,
            vec![group]
        );
        Ok(())
    }
    #[test]
    fn session_scope_includes_reparented_groups_but_excludes_independent_daemons() -> Result<()> {
        let leader = row(100, std::process::id(), 100, 1);
        let mut owner = Ownership::new(leader.clone())?;
        let orphan = row(101, 1, 101, 2);
        let independent = Identity {
            session: 102,
            ..row(102, 100, 102, 3)
        };
        let table = BTreeMap::from([
            (100, leader.clone()),
            (101, orphan.clone()),
            (102, independent),
        ]);
        assert_eq!(
            owner.discover(&table)?,
            vec![leader.clone(), orphan.clone()]
        );
        assert_eq!(
            owner.discover(&BTreeMap::from([(101, orphan.clone())]))?,
            vec![orphan]
        );
        let detached = Identity {
            session: 101,
            ..row(101, 1, 101, 2)
        };
        assert!(owner
            .discover(&BTreeMap::from([(101, detached)]))?
            .is_empty());
        let mut fresh = Ownership::new(leader)?;
        assert!(fresh
            .discover(&BTreeMap::from([(103, row(103, 1, 103, 4))]))
            .is_err());
        Ok(())
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn audit_signal_rejects_a_delivery_window_version_change_without_pid_fallback() -> Result<()> {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        let outcome = (|| -> Result<()> {
            let row = identity(child.id())?.context("Owned child identity missing")?;
            for _ in 0..16 {
                signal(&row, libc::SIGCONT)?;
            }
            let error = signal_macos(&row, libc::SIGCONT, |token| {
                token.values[7] = token.values[7].wrapping_add(1);
            })
            .err()
            .context("Stale audit identity was accepted or downgraded to PID signaling")?;
            anyhow::ensure!(error.to_string().contains("audit version changed"));
            let reused = Identity {
                birth: row.birth + 1,
                ..row
            };
            anyhow::ensure!(signal(&reused, libc::SIGCONT).is_err());
            Ok(())
        })();
        let status = child.wait()?;
        anyhow::ensure!(status.success());
        outcome
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pidfd_signal_checks_birth_before_delivery() -> Result<()> {
        let own = identity(std::process::id())?.context("Own identity missing")?;
        signal(&own, 0)?;
        let reused = Identity {
            birth: own.birth + 1,
            ..own
        };
        assert!(signal(&reused, 0).is_err());
        Ok(())
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn stat_parser_handles_spaces_parentheses_and_newlines() -> Result<()> {
        let mut bytes = b"123 (odd ) process\nname) S 10 123 ".to_vec();
        bytes.extend(b"123 ");
        bytes.extend("0 ".repeat(15).as_bytes());
        bytes.extend(b"777 0");
        let row = parse_stat(&bytes)?;
        assert_eq!(row.pid, 123);
        assert_eq!(row.birth, 777);
        assert_eq!(row.session, 123);
        assert_eq!(row.name, "odd ) process\nname");
        Ok(())
    }
}
