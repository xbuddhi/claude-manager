//! Process queries and process-tree termination.
//!
//! Killing only the direct child leaves node, MCP servers and tool shells running. On Windows every
//! child is also put in one Job Object that closes when this app exits (even on a crash), which ends
//! whole trees; on Unix the PTY child leads its own process group (portable-pty calls setsid), so the
//! group is signalled, and every descendant is signalled as well (some move to groups of their own).
//!
//! Pids are reused. Every walk of the process tree checks start times: a process is another's child only
//! if it did not start before it, and a process is signalled only while its start time still matches.

use super::error::lock;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

/// How long each polite signal gets before the next, harder one (Unix; Windows ends trees at once).
/// Closing a tab or ending a background session can wait for claude to save.
pub const GRACE: Duration = Duration::from_secs(2);
/// The same while the app quits, which must not hang.
pub const GRACE_ON_EXIT: Duration = Duration::from_millis(300);

/// Process table, refreshed on demand. Managed as state by `core::init`.
pub struct Procs {
    sys: Mutex<System>,
}

impl Default for Procs {
    fn default() -> Self {
        Self::new()
    }
}

impl Procs {
    pub fn new() -> Self {
        Self {
            sys: Mutex::new(System::new()),
        }
    }

    /// Refreshes `which` processes and runs `f` on the table. One refresh can serve many queries.
    pub fn with<T>(&self, which: ProcessesToUpdate<'_>, f: impl FnOnce(&System) -> T) -> T {
        let mut sys = lock(&self.sys);
        let kind = ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet);
        sys.refresh_processes_specifics(which, true, kind);
        f(&sys)
    }

    /// Refreshes every process without reading command lines, then reads the command lines of `cmd_for`
    /// only. The live scan runs every 2 s while claude starts many short helper processes: reading each new
    /// one's command line was most of the scan's cost.
    pub fn with_cmd_of<T>(&self, cmd_for: &[Pid], f: impl FnOnce(&System) -> T) -> T {
        let mut sys = lock(&self.sys);
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        if !cmd_for.is_empty() {
            let kind = ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet);
            sys.refresh_processes_specifics(ProcessesToUpdate::Some(cmd_for), false, kind);
        }
        f(&sys)
    }

    pub fn alive(&self, pid: u32) -> bool {
        let pid = Pid::from_u32(pid);
        self.with(ProcessesToUpdate::Some(&[pid]), |s| s.process(pid).is_some())
    }

    pub fn name(&self, pid: u32) -> Option<String> {
        let pid = Pid::from_u32(pid);
        self.with(ProcessesToUpdate::Some(&[pid]), |s| {
            s.process(pid).map(|p| p.name().to_string_lossy().into_owned())
        })
    }

    /// Start time in seconds since the Unix epoch; with the pid it identifies a process despite pid reuse.
    pub fn start_time(&self, pid: u32) -> Option<u64> {
        let pid = Pid::from_u32(pid);
        self.with(ProcessesToUpdate::Some(&[pid]), |s| {
            s.process(pid).map(|p| p.start_time())
        })
    }

    pub fn cmdline(&self, pid: u32) -> Option<Vec<String>> {
        let pid = Pid::from_u32(pid);
        self.with(ProcessesToUpdate::Some(&[pid]), |s| {
            s.process(pid)
                .map(|p| p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect())
        })
    }

    /// Parent, grandparent, ... of `pid`, nearest first.
    pub fn parent_chain(&self, pid: u32) -> Vec<u32> {
        self.with(ProcessesToUpdate::All, |s| parent_chain(&table(s), pid))
    }

    /// Every process below `pid`, parents before children.
    pub fn descendants_of(&self, pid: u32) -> Vec<u32> {
        self.with(ProcessesToUpdate::All, |s| descendants(&table(s), pid))
    }
}

/// pid -> (recorded parent pid, start time).
type Table = HashMap<u32, (Option<u32>, u64)>;

fn table(sys: &System) -> Table {
    sys.processes()
        .iter()
        .map(|(pid, p)| (pid.as_u32(), (p.parent().map(Pid::as_u32), p.start_time())))
        .collect()
}

/// The parent of `pid`, if it is still the process that started it. Windows keeps a dead parent's pid in
/// its children's records, so once that pid is reused an unrelated, newer process would look like their
/// parent. A real parent never starts after its child (start times have one-second resolution: `<=`).
fn real_parent(t: &Table, pid: u32) -> Option<u32> {
    let &(parent, start) = t.get(&pid)?;
    let parent = parent?;
    let &(_, parent_start) = t.get(&parent)?;
    (parent_start <= start).then_some(parent)
}

fn parent_chain(t: &Table, pid: u32) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut seen = HashSet::from([pid]);
    let mut cur = pid;
    while let Some(parent) = real_parent(t, cur) {
        // equal start times can still form a cycle after pid reuse
        if !seen.insert(parent) {
            break;
        }
        chain.push(parent);
        cur = parent;
    }
    chain
}

fn descendants(t: &Table, pid: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &child in t.keys() {
        if let Some(parent) = real_parent(t, child) {
            children.entry(parent).or_default().push(child);
        }
    }
    let mut out = Vec::new();
    let mut seen = HashSet::from([pid]);
    let mut queue = vec![pid];
    while let Some(next) = queue.pop() {
        for &c in children.get(&next).into_iter().flatten() {
            if seen.insert(c) {
                out.push(c);
                queue.push(c);
            }
        }
    }
    out
}

/// Ends each process in `pids` together with everything it started. On Unix it sends SIGHUP, then
/// SIGTERM, then SIGKILL, waiting up to `grace` after each of the first two, so call it off the UI thread.
pub fn kill_trees(pids: &[u32], grace: Duration) {
    if pids.is_empty() {
        return;
    }
    imp::kill_trees(pids, grace);
}

/// [`kill_trees`] for one process, with the normal [`GRACE`].
pub fn kill_tree(pid: u32) {
    kill_trees(&[pid], GRACE);
}

#[cfg(windows)]
mod imp {
    use super::*;

    pub fn kill_trees(pids: &[u32], _grace: Duration) {
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let t = table(&sys);
        for &root in pids {
            // children first, so nothing gets a chance to respawn into the tree
            let mut tree = descendants(&t, root);
            tree.reverse();
            tree.push(root);
            for pid in tree {
                if let Some(p) = sys.process(Pid::from_u32(pid)) {
                    p.kill();
                }
            }
        }
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::time::Instant;
    use sysinfo::ProcessStatus;

    /// A process to signal, with the start time that tells it apart from a later process with its pid.
    struct Target {
        pid: libc::pid_t,
        start: u64,
    }

    pub fn kill_trees(roots: &[u32], grace: Duration) {
        let mut sys = System::new();
        refresh(&mut sys);
        // groups led by a root: killpg also reaches members started after this snapshot
        let groups: Vec<Target> = roots
            .iter()
            .filter_map(|&r| target(&sys, r))
            .filter(|t| pgid(t.pid) == Some(t.pid))
            .collect();
        let targets = snapshot(&sys, roots);
        // SIGHUP is what a closing terminal sends; claude saves and exits on it
        for signal in [libc::SIGHUP, libc::SIGTERM] {
            send(&mut sys, &groups, &targets, signal);
            if wait_gone(&mut sys, &targets, grace) {
                return;
            }
        }
        send(&mut sys, &groups, &targets, libc::SIGKILL);
    }

    fn refresh(sys: &mut System) {
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    }

    fn target(sys: &System, pid: u32) -> Option<Target> {
        let raw = libc::pid_t::try_from(pid).ok().filter(|&p| p > 0)?;
        let p = sys.process(Pid::from_u32(pid))?;
        Some(Target {
            pid: raw,
            start: p.start_time(),
        })
    }

    fn pgid(pid: libc::pid_t) -> Option<libc::pid_t> {
        // SAFETY: getpgid only reads the process table
        let g = unsafe { libc::getpgid(pid) };
        (g > 0).then_some(g)
    }

    /// Each root, its descendants, and every member of a group a root leads (a member whose parent
    /// already exited is no longer anyone's descendant).
    fn snapshot(sys: &System, roots: &[u32]) -> Vec<Target> {
        let t = table(sys);
        let mut pids: Vec<u32> = Vec::new();
        for &root in roots {
            pids.push(root);
            pids.extend(descendants(&t, root));
            if let Some(leader) = target(sys, root).filter(|r| pgid(r.pid) == Some(r.pid)) {
                let members = t
                    .keys()
                    .copied()
                    .filter(|&p| libc::pid_t::try_from(p).ok().and_then(pgid) == Some(leader.pid));
                pids.extend(members);
            }
        }
        let mut seen = HashSet::new();
        pids.into_iter()
            .filter(|p| seen.insert(*p))
            .filter_map(|p| target(sys, p))
            .collect()
    }

    /// Still the process that was found: not exited, not a zombie, pid not reused.
    fn running(sys: &System, t: &Target) -> bool {
        sys.process(Pid::from_u32(t.pid as u32))
            .is_some_and(|p| p.start_time() == t.start && p.status() != ProcessStatus::Zombie)
    }

    fn send(sys: &mut System, groups: &[Target], targets: &[Target], signal: i32) {
        refresh(sys);
        for g in groups {
            // a reaped leader's group can outlive it, and its id is not reused while the group exists
            let same_leader = sys
                .process(Pid::from_u32(g.pid as u32))
                .is_none_or(|p| p.start_time() == g.start);
            if same_leader {
                // SAFETY: plain syscall; g.pid > 0, so it never targets every process or our own group
                unsafe { libc::killpg(g.pid, signal) };
            }
        }
        for t in targets.iter().filter(|t| running(sys, t)) {
            // SAFETY: plain syscall on a positive pid that was just checked to be the same process
            unsafe { libc::kill(t.pid, signal) };
        }
    }

    fn wait_gone(sys: &mut System, targets: &[Target], timeout: Duration) -> bool {
        let start = Instant::now();
        loop {
            refresh(sys);
            if !targets.iter().any(|t| running(sys, t)) {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(windows)]
pub use job::{assign_to_job, init_job};

#[cfg(windows)]
mod job {
    use crate::core::error::{AppError, AppResult};
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    struct Job(HANDLE);
    // SAFETY: a job handle is a kernel object handle, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Job> = OnceLock::new();

    /// Creates the app-wide job. Its handle is never closed: Windows closes it when this process ends,
    /// and KILL_ON_JOB_CLOSE then ends every process assigned to it, so a crash leaves no terminal's
    /// process behind.
    ///
    /// SILENT_BREAKAWAY_OK keeps the job to the processes assigned to it (each terminal's own process):
    /// what they start does not join it. Otherwise a browser that `/login` opens, `code .` or a dev server
    /// started inside claude would be killed whenever Claude Manager quits. Console programs claude
    /// starts still end with it: they share the terminal's console, which closes with this process; a
    /// normal quit ends each terminal's whole tree (`kill_trees`).
    pub fn init_job() -> AppResult<()> {
        if JOB.get().is_some() {
            return Ok(());
        }
        // SAFETY: documented Win32 calls with valid arguments; the info struct outlives the call.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                let err = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(err.into());
            }
            if JOB.set(Job(handle)).is_err() {
                CloseHandle(handle); // another thread won the race
            }
        }
        Ok(())
    }

    /// Puts `pid` (not what it starts later, see `init_job`) in the app-wide job.
    pub fn assign_to_job(pid: u32) -> AppResult<()> {
        let job = JOB
            .get()
            .ok_or_else(|| AppError::Internal("job object not initialized".into()))?;
        // SAFETY: documented Win32 calls; the process handle is closed on every path.
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            let ok = AssignProcessToJobObject(job.0, process);
            let err = std::io::Error::last_os_error();
            CloseHandle(process);
            if ok == 0 {
                return Err(err.into());
            }
        }
        Ok(())
    }

    /// Whether `pid` is in the app-wide job (tests).
    #[cfg(test)]
    pub fn in_job(pid: u32) -> bool {
        use windows_sys::Win32::System::JobObjects::IsProcessInJob;
        use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
        let Some(job) = JOB.get() else { return false };
        // SAFETY: documented Win32 calls; the process handle is closed on every path.
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut result = 0;
            let ok = IsProcessInJob(process, job.0, &mut result);
            CloseHandle(process);
            ok != 0 && result != 0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::time::Instant;

    /// A child that stays alive for about 30 s and starts a grandchild; on Unix optionally leading its
    /// own process group, like a PTY child.
    fn spawn_tree(own_group: bool) -> Child {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/d", "/c", "ping -n 30 127.0.0.1 >NUL"]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30; true"]);
            c
        };
        #[cfg(unix)]
        if own_group {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        let _ = own_group;
        cmd.stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
    }

    fn wait_for(cond: impl Fn() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn queries_own_process() {
        let procs = Procs::new();
        let me = std::process::id();
        assert!(procs.alive(me));
        assert!(procs.name(me).is_some_and(|n| !n.is_empty()));
        assert!(procs.start_time(me).is_some_and(|t| t > 0));
        assert!(!procs.parent_chain(me).is_empty());
    }

    #[test]
    fn stale_parent_links_are_not_followed() {
        // 20 started at t=100 under 10; 10 died and its pid went to a process started at t=200
        let t: Table = HashMap::from([
            (1, (None, 0)),
            (10, (Some(1), 200)),
            (20, (Some(10), 100)),
            (30, (Some(20), 150)),
            (40, (Some(10), 250)),
        ]);
        assert_eq!(real_parent(&t, 20), None);
        assert_eq!(parent_chain(&t, 30), [20]);
        assert_eq!(parent_chain(&t, 40), [10, 1]);
        assert_eq!(descendants(&t, 10), [40]);
        assert_eq!(descendants(&t, 20), [30]);
        // reused pids with equal start times can form a cycle; the walk still ends
        let cyclic: Table = HashMap::from([(1, (Some(2), 5)), (2, (Some(1), 5))]);
        assert_eq!(parent_chain(&cyclic, 1), [2]);
    }

    fn kills_child_and_grandchild(own_group: bool) {
        let procs = Procs::new();
        let mut child = spawn_tree(own_group);
        let pid = child.id();
        assert!(
            wait_for(|| !procs.descendants_of(pid).is_empty()),
            "grandchild never started"
        );
        let tree = procs.descendants_of(pid);
        assert!(procs.parent_chain(tree[0]).contains(&pid));

        kill_tree(pid);
        let _ = child.wait();
        assert!(
            wait_for(|| tree.iter().all(|&p| !procs.alive(p))),
            "a descendant survived"
        );
    }

    #[test]
    fn kill_tree_ends_a_group_leader_and_its_children() {
        kills_child_and_grandchild(true);
    }

    #[test]
    fn kill_tree_ends_a_process_that_leads_no_group() {
        kills_child_and_grandchild(false);
    }

    #[cfg(windows)]
    #[test]
    fn assigns_children_to_the_job() {
        init_job().unwrap();
        let mut child = spawn_tree(true);
        assign_to_job(child.id()).unwrap();
        kill_tree(child.id());
        let _ = child.wait();
    }

    /// What an assigned process starts later (a browser opened by /login, `code .`) stays out of the
    /// job, so quitting the app does not kill it.
    #[cfg(windows)]
    #[test]
    fn processes_started_later_by_a_job_member_stay_out_of_the_job() {
        init_job().unwrap();
        let mut child = Command::new("cmd")
            .args(["/d", "/c", "ping -n 2 127.0.0.1 >NUL & ping -n 30 127.0.0.1 >NUL"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assign_to_job(child.id()).unwrap();
        assert!(job::in_job(child.id()));
        // the second ping starts about a second after the assignment
        let started_later = || {
            std::thread::sleep(Duration::from_millis(1500));
            Procs::new().descendants_of(child.id())
        };
        let later = started_later();
        assert!(!later.is_empty());
        assert!(later.iter().all(|&pid| !job::in_job(pid)), "{later:?}");
        kill_tree(child.id());
        let _ = child.wait();
    }
}
