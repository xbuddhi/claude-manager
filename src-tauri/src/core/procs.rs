//! Process queries and process-tree termination.
//!
//! Killing only the direct child leaves node, MCP servers and tool shells running. On Windows every
//! child is also put in one Job Object that closes when this app exits (even on a crash), which ends
//! whole trees; on Unix the PTY child leads its own process group (portable-pty calls setsid), so the
//! group is signalled.

use super::error::lock;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

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
        self.with(ProcessesToUpdate::All, |s| parent_chain_in(s, pid))
    }

    /// Every process below `pid`, parents before children.
    pub fn descendants_of(&self, pid: u32) -> Vec<u32> {
        self.with(ProcessesToUpdate::All, |s| descendants_in(s, pid))
    }
}

fn parent_chain_in(sys: &System, pid: u32) -> Vec<u32> {
    let mut chain = Vec::new();
    let mut seen = HashSet::from([pid]);
    let mut cur = Pid::from_u32(pid);
    while let Some(parent) = sys.process(cur).and_then(|p| p.parent()) {
        // pid reuse can make the table cyclic
        if !seen.insert(parent.as_u32()) {
            break;
        }
        chain.push(parent.as_u32());
        cur = parent;
    }
    chain
}

fn descendants_in(sys: &System, pid: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (p, proc_) in sys.processes() {
        if let Some(parent) = proc_.parent() {
            children.entry(parent.as_u32()).or_default().push(p.as_u32());
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

/// Ends each process in `pids` together with everything it started. Blocks for up to about 0.6 s on
/// Unix (graceful signals first), so call it off the UI thread.
pub fn kill_trees(pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    imp::kill_trees(pids);
}

pub fn kill_tree(pid: u32) {
    kill_trees(&[pid]);
}

#[cfg(windows)]
mod imp {
    use super::*;

    pub fn kill_trees(pids: &[u32]) {
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        for &root in pids {
            // children first, so nothing gets a chance to respawn into the tree
            let mut tree = descendants_in(&sys, root);
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
    use std::time::{Duration, Instant};

    const GRACE: Duration = Duration::from_millis(300);

    pub fn kill_trees(pids: &[u32]) {
        // SIGHUP is what a closing terminal sends; claude saves and exits on it
        for signal in [libc::SIGHUP, libc::SIGTERM] {
            signal_all(pids, signal);
            if wait_gone(pids, GRACE) {
                return;
            }
        }
        signal_all(pids, libc::SIGKILL);
    }

    fn signal_all(pids: &[u32], signal: i32) {
        for &pid in pids {
            let Ok(pid) = i32::try_from(pid) else { continue };
            // SAFETY: plain syscalls; pid > 0 so neither call can target our own group or every process
            unsafe {
                if pid > 0 && libc::killpg(pid, signal) != 0 {
                    // not a group leader: signal the process alone
                    libc::kill(pid, signal);
                }
            }
        }
    }

    fn wait_gone(pids: &[u32], timeout: Duration) -> bool {
        let start = Instant::now();
        loop {
            // SAFETY: signal 0 only checks that the group still exists
            let any_alive = pids.iter().any(|&pid| unsafe { libc::killpg(pid as i32, 0) == 0 });
            if !any_alive {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
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
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    struct Job(HANDLE);
    // SAFETY: a job handle is a kernel object handle, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Job> = OnceLock::new();

    /// Creates the app-wide job. Its handle is never closed: Windows closes it when this process ends,
    /// and KILL_ON_JOB_CLOSE then ends every process assigned to it.
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
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
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

    /// Puts `pid` (and so everything it starts later) in the app-wide job.
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    /// A child that stays alive for about 30 s and starts a grandchild.
    fn spawn_tree() -> Child {
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
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0); // like a PTY child, which leads its own group
        }
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
    fn kill_tree_ends_child_and_grandchild() {
        let procs = Procs::new();
        let mut child = spawn_tree();
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

    #[cfg(windows)]
    #[test]
    fn assigns_children_to_the_job() {
        init_job().unwrap();
        let mut child = spawn_tree();
        assign_to_job(child.id()).unwrap();
        kill_tree(child.id());
        let _ = child.wait();
    }
}
