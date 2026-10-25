//! Can the app bring a running session to the front? Yes when it runs in one of the app's own terminals,
//! or when a process it descends from has a window: on Windows a console window or a main window, on
//! macOS a terminal app (Terminal, iTerm2, ...). A session with neither is an orphan, typically left
//! running by a terminal window that was killed.

use super::snapshot::Snapshot;
use std::collections::HashSet;

/// How far up the process tree a host is looked for (claude -> shell -> console host -> terminal ...).
pub const HOST_DEPTH: usize = 6;
/// The same for matching the app's own terminals (the claude.cmd shim adds cmd and node levels).
pub const TERM_DEPTH: usize = 7;

/// What one scan knows about hosts: the app's terminal children and the processes that own a window.
#[derive(Default)]
pub struct Hosts {
    pub term_pids: HashSet<u32>,
    /// Windows: pids owning a console window or a visible main window.
    pub window_pids: HashSet<u32>,
}

impl Hosts {
    pub fn collect(term_pids: Vec<u32>) -> Self {
        Hosts {
            term_pids: term_pids.into_iter().collect(),
            #[cfg(windows)]
            window_pids: win::windows().into_iter().map(|w| w.pid).collect(),
            #[cfg(not(windows))]
            window_pids: HashSet::new(),
        }
    }

    /// `pid` runs in one of the app's own terminals.
    pub fn in_app(&self, snap: &Snapshot, pid: u32) -> bool {
        snap.chain(pid, TERM_DEPTH).iter().any(|p| self.term_pids.contains(p))
    }

    pub fn reachable(&self, snap: &Snapshot, pid: u32) -> bool {
        if self.in_app(snap, pid) {
            return true;
        }
        let me = std::process::id();
        snap.chain(pid, HOST_DEPTH).iter().any(|&p| {
            // the desktop shell (explorer) has windows too, but none of them shows a session
            p == me
                || (self.window_pids.contains(&p) && snap.get(p).is_some_and(|x| x.name != "explorer"))
                || (cfg!(target_os = "macos") && snap.get(p).is_some_and(|x| is_terminal_app(&x.name)))
        })
    }
}

/// macOS process names of apps a terminal session can live in.
pub fn is_terminal_app(name: &str) -> bool {
    const APPS: &[&str] = &[
        "terminal",
        "iterm2",
        "warp",
        "stable", // Warp's binary
        "wezterm",
        "wezterm-gui",
        "alacritty",
        "kitty",
        "ghostty",
        "tabby",
        "hyper",
        "code",
        "electron", // VS Code's main binary in older builds
        "cursor",
    ];
    // VS Code's integrated terminal runs under "Code Helper (Plugin)"
    APPS.contains(&name) || name.starts_with("code helper") || name.starts_with("cursor helper")
}

#[cfg(windows)]
pub mod win {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GW_OWNER, GetClassNameW, GetWindow, GetWindowThreadProcessId, IsWindowVisible,
    };

    #[derive(Clone, Copy, Debug)]
    pub struct Win {
        pub hwnd: HWND,
        pub pid: u32,
        /// A classic console window (it reports the pid of the shell attached to it, even while hidden).
        pub console: bool,
    }

    /// Top-level windows that are console windows or visible main windows (no owner), in z-order.
    pub fn windows() -> Vec<Win> {
        let mut out: Vec<Win> = Vec::new();
        // SAFETY: EnumWindows calls `collect` synchronously with the pointer to `out`, which outlives the call.
        unsafe { EnumWindows(Some(collect), &raw mut out as LPARAM) };
        out
    }

    unsafe extern "system" fn collect(hwnd: HWND, data: LPARAM) -> i32 {
        // SAFETY: `data` is the `&mut Vec<Win>` passed by `windows`; the handle comes from EnumWindows.
        unsafe {
            let out = &mut *(data as *mut Vec<Win>);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
            let console = String::from_utf16_lossy(&class[..n.max(0) as usize]) == "ConsoleWindowClass";
            let main = IsWindowVisible(hwnd) != 0 && GetWindow(hwnd, GW_OWNER).is_null();
            if pid != 0 && (console || main) {
                out.push(Win { hwnd, pid, console });
            }
        }
        1
    }
}

#[cfg(test)]
mod tests {
    use super::super::snapshot::tests::proc;
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn reachable_through_own_terminals_or_a_window_ancestor() {
        let me = std::process::id();
        let snap = Snapshot::from_map(HashMap::from([
            (me, proc(None, 1, "claude-manager")),
            (2, proc(Some(me), 5, "claude")),
            (3, proc(Some(2), 6, "node")),
            (10, proc(None, 1, "windowsterminal")),
            (11, proc(Some(10), 5, "pwsh")),
            (12, proc(Some(11), 6, "claude")),
            (20, proc(None, 1, "explorer")),
            (21, proc(Some(20), 5, "pwsh")),
            (22, proc(Some(21), 6, "claude")),
            (30, proc(None, 7, "claude")),
        ]));
        let hosts = Hosts {
            term_pids: HashSet::from([2]),
            window_pids: HashSet::from([10, 20]),
        };
        assert!(hosts.in_app(&snap, 3) && hosts.reachable(&snap, 3));
        assert!(!hosts.in_app(&snap, 12));
        assert!(hosts.reachable(&snap, 12));
        // the desktop shell's window does not count
        assert!(!hosts.reachable(&snap, 22));
        assert!(!hosts.reachable(&snap, 30));
    }

    #[test]
    fn terminal_apps() {
        for n in ["terminal", "iterm2", "code helper (plugin)", "ghostty"] {
            assert!(is_terminal_app(n), "{n}");
        }
        assert!(!is_terminal_app("launchd") && !is_terminal_app("tmux"));
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_windows_without_failing() {
        // a test runner may have no window at all; this only proves the call is sound
        let _ = win::windows();
    }
}
