//! One copy of the process table per scan, so a tick asks the system once and then walks it freely.

use crate::core::procs::{self, Procs};
use std::collections::{HashMap, HashSet};
use sysinfo::System;

#[derive(Clone, Debug, Default)]
pub struct Proc {
    /// Recorded parent pid (may be stale; see [`Snapshot::parent`]).
    pub parent: Option<u32>,
    /// Start time, seconds since the Unix epoch.
    pub start: u64,
    /// Lowercase, without `.exe`.
    pub name: String,
    /// Command line; filled only for the pids asked for.
    pub cmd: Vec<String>,
}

#[derive(Default)]
pub struct Snapshot {
    procs: HashMap<u32, Proc>,
}

impl Snapshot {
    /// Reads every process, with the command lines of `cmd_for`, from the shared table.
    pub fn take(procs: &Procs, cmd_for: &HashSet<u32>) -> Self {
        let wanted = pids(cmd_for);
        procs.with_cmd_of(&wanted, |sys| Self::of(sys, cmd_for))
    }

    /// The same from a table of the caller's own (the live scan keeps one, so the shared table is not
    /// locked for a whole refresh while terminals query it).
    pub fn take_own(sys: &mut System, cmd_for: &HashSet<u32>) -> Self {
        procs::refresh_all(sys, &pids(cmd_for));
        Self::of(sys, cmd_for)
    }

    fn of(sys: &System, cmd_for: &HashSet<u32>) -> Self {
        Snapshot {
            procs: sys
                .processes()
                .iter()
                .map(|(pid, p)| {
                    let pid = pid.as_u32();
                    let cmd = if cmd_for.contains(&pid) {
                        p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect()
                    } else {
                        Vec::new()
                    };
                    let proc = Proc {
                        parent: p.parent().map(|p| p.as_u32()),
                        start: p.start_time(),
                        name: short_name(&p.name().to_string_lossy()),
                        cmd,
                    };
                    (pid, proc)
                })
                .collect(),
        }
    }

    /// No processes (a scan with nothing to look at).
    pub fn empty() -> Self {
        Snapshot::default()
    }

    #[cfg(test)]
    pub fn from_map(procs: HashMap<u32, Proc>) -> Self {
        Snapshot { procs }
    }

    pub fn get(&self, pid: u32) -> Option<&Proc> {
        self.procs.get(&pid)
    }

    /// The parent of `pid`, if it is still the process that started it: a reused parent pid belongs to a
    /// process that started after its "child" (start times have one-second resolution: `<=`).
    pub fn parent(&self, pid: u32) -> Option<u32> {
        let p = self.procs.get(&pid)?;
        let parent = p.parent.filter(|&pp| pp != pid)?;
        (self.procs.get(&parent)?.start <= p.start).then_some(parent)
    }

    /// `pid` itself, then its parent, grandparent, ...: at most `max` pids, only running ones.
    pub fn chain(&self, pid: u32, max: usize) -> Vec<u32> {
        let mut out = Vec::new();
        let mut cur = self.procs.contains_key(&pid).then_some(pid);
        while let Some(p) = cur {
            if out.len() >= max || out.contains(&p) {
                break;
            }
            out.push(p);
            cur = self.parent(p);
        }
        out
    }
}

/// `Claude.EXE` -> `claude`: names compare lowercase and without the Windows extension. One allocation
/// (this runs for every process on every scan).
pub fn short_name(name: &str) -> String {
    let mut lower = if name.is_ascii() {
        name.to_ascii_lowercase()
    } else {
        name.to_lowercase()
    };
    if lower.ends_with(".exe") {
        lower.truncate(lower.len() - ".exe".len());
    }
    lower
}

fn pids(set: &HashSet<u32>) -> Vec<sysinfo::Pid> {
    set.iter().map(|&p| sysinfo::Pid::from_u32(p)).collect()
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn proc(parent: Option<u32>, start: u64, name: &str) -> Proc {
        Proc {
            parent,
            start,
            name: name.into(),
            cmd: Vec::new(),
        }
    }

    #[test]
    fn chains_stop_at_reused_parents_and_cycles() {
        let snap = Snapshot::from_map(HashMap::from([
            (1, proc(None, 10, "init")),
            (2, proc(Some(1), 20, "wt")),
            (3, proc(Some(2), 30, "pwsh")),
            (4, proc(Some(3), 40, "claude")),
            // its parent pid 3 was reused by a newer process
            (5, proc(Some(3), 25, "claude")),
            (6, proc(Some(7), 50, "a")),
            (7, proc(Some(6), 50, "b")),
        ]));
        assert_eq!(snap.chain(4, 10), [4, 3, 2, 1]);
        assert_eq!(snap.chain(4, 2), [4, 3]);
        assert_eq!(snap.chain(5, 10), [5]);
        assert_eq!(snap.chain(6, 10), [6, 7]);
        assert!(snap.chain(99, 10).is_empty());
    }

    #[test]
    fn short_names() {
        assert_eq!(short_name("Claude.EXE"), "claude");
        assert_eq!(short_name("2.1.310"), "2.1.310");
        assert_eq!(short_name("Code Helper (Plugin)"), "code helper (plugin)");
        assert_eq!(short_name("ÄPP.exe"), "äpp");
    }

    #[test]
    fn takes_the_real_table() {
        let me = std::process::id();
        let snap = Snapshot::take(&Procs::new(), &HashSet::from([me]));
        let p = snap.get(me).unwrap();
        assert!(p.start > 0 && !p.name.is_empty() && !p.cmd.is_empty());
        let mut own = System::new();
        let again = Snapshot::take_own(&mut own, &HashSet::from([me]));
        assert_eq!(again.get(me).map(|p| (&p.name, p.start)), Some((&p.name, p.start)));
    }
}
