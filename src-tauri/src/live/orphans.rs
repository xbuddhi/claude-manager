//! "Close background sessions": running claude processes that no window can reach (left over from
//! terminals that were killed). They use memory; their work is saved and can be resumed.

use super::reach::Hosts;
use super::scan::Found;
use super::snapshot::Snapshot;
use super::types::Orphan;
use crate::core::{paths, procs};
use std::collections::HashSet;
use std::path::Path;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};

/// A parent that only existed to run claude, and is ended with it.
const WRAPPERS: &[&str] = &["pwsh", "powershell", "cmd", "node", "bash", "zsh", "sh", "fish"];

/// Running sessions of `profile` (or of every profile) that are neither in the app's terminals nor
/// reachable from a window. One entry per process.
pub fn find(found: &[Found], snap: &Snapshot, hosts: &Hosts, profile: Option<&Path>) -> Vec<Orphan> {
    let mut seen = HashSet::new();
    found
        .iter()
        .filter(|f| profile.is_none_or(|p| paths::same(p, &f.profile)))
        .filter(|f| !hosts.reachable(snap, f.pid))
        .filter(|f| seen.insert(f.pid))
        .map(|f| Orphan {
            pid: f.pid,
            session_id: f.session_id.clone(),
            cwd: f.cwd.clone(),
            profile: f.profile.to_string_lossy().into_owned(),
        })
        .collect()
}

/// Ends each of `pids` that is in `orphans` (anything else is ignored), with its process tree, and its
/// parent when that is a shell or node wrapper. Never touches this app or its ancestors. Blocking.
/// Returns how many were ended.
pub fn close(pids: &[u32], orphans: &[Orphan], snap: &Snapshot) -> u32 {
    let protected: HashSet<u32> = snap.chain(std::process::id(), usize::MAX).into_iter().collect();
    let targets: Vec<u32> = pids
        .iter()
        .copied()
        .filter(|p| orphans.iter().any(|o| o.pid == *p) && !protected.contains(p))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let parents: Vec<(u32, u64)> = targets
        .iter()
        .filter_map(|&pid| snap.parent(pid))
        .filter(|pp| !protected.contains(pp) && !targets.contains(pp))
        .filter_map(|pp| snap.get(pp).map(|p| (pp, p)))
        .filter(|(_, p)| WRAPPERS.contains(&p.name.as_str()))
        .map(|(pp, p)| (pp, p.start))
        .collect();
    procs::kill_trees(&targets, procs::GRACE);
    for (pid, start) in parents {
        end_one(pid, start);
    }
    targets.len() as u32
}

/// Ends one process (not its other children), only while it is still the one that was found.
fn end_one(pid: u32, start: u64) {
    let pid = Pid::from_u32(pid);
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
    if let Some(p) = sys.process(pid).filter(|p| p.start_time() == start) {
        // a shell exits on hangup; Windows has only the hard kill
        if p.kill_with(Signal::Hangup) != Some(true) {
            p.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::snapshot::tests::proc;
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn found(pid: u32, profile: &str) -> Found {
        Found {
            session_id: format!("0f8c2a4e-1b2c-4d5e-8f90-a1b2c3d4e{pid:03}"),
            pid,
            level: 1,
            cwd: Some(format!("C:\\code\\p{pid}")),
            profile: PathBuf::from(profile),
        }
    }

    #[test]
    fn orphans_are_unreachable_processes_of_the_profile() {
        let snap = Snapshot::from_map(HashMap::from([
            (1, proc(None, 1, "windowsterminal")),
            (2, proc(Some(1), 2, "claude")),
            (3, proc(None, 2, "claude")),
            (4, proc(None, 2, "claude")),
            (5, proc(None, 2, "claude")),
        ]));
        let hosts = Hosts {
            term_pids: HashSet::from([5]),
            window_pids: HashSet::from([1]),
        };
        let all = [
            found(2, "/h/.claude"),
            found(3, "/h/.claude"),
            found(3, "/h/.claude"),
            found(4, "/h/.claude-work"),
            found(5, "/h/.claude"),
        ];
        let pids = |o: Vec<Orphan>| o.into_iter().map(|o| o.pid).collect::<Vec<_>>();
        assert_eq!(pids(find(&all, &snap, &hosts, None)), [3, 4]);
        assert_eq!(
            pids(find(&all, &snap, &hosts, Some(Path::new("/h/.claude-work/")))),
            [4]
        );
    }

    fn sleeper() -> std::process::Child {
        let mut cmd = if cfg!(windows) {
            let mut c = std::process::Command::new("ping");
            c.args(["-n", "30", "127.0.0.1"]);
            c
        } else {
            let mut c = std::process::Command::new("sleep");
            c.arg("30");
            c
        };
        cmd.stdout(std::process::Stdio::null()).spawn().unwrap()
    }

    #[test]
    fn closes_only_listed_orphans() {
        let mut orphan = sleeper();
        let mut other = sleeper();
        let snap = Snapshot::take(&procs::Procs::new(), &HashSet::new());
        let orphans = [Orphan {
            pid: orphan.id(),
            session_id: "x".into(),
            cwd: None,
            profile: "/h/.claude".into(),
        }];
        // `other` and this test process are not orphans and must survive
        let closed = close(&[orphan.id(), other.id(), std::process::id()], &orphans, &snap);
        assert_eq!(closed, 1);
        let started = Instant::now();
        while orphan.try_wait().unwrap().is_none() {
            assert!(started.elapsed() < Duration::from_secs(5), "orphan survived");
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(other.try_wait().unwrap().is_none());
        other.kill().unwrap();
        let _ = other.wait();
    }
}
