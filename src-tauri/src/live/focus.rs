//! "Switch to running session" for a session outside the app's tabs (the frontend tries its tabs first):
//! the window of a process the session descends from, else any Windows Terminal / Terminal.app window.

use super::snapshot::Snapshot;
use crate::core::lifecycle;
use tauri::AppHandle;

/// Ancestors searched for a window (claude -> shell -> console host -> terminal ...).
const DEPTH: usize = 7;

/// Brings the window `pid` runs in to the front. False when none was found.
pub fn bring_forward(app: &AppHandle, snap: &Snapshot, pid: u32) -> bool {
    let me = std::process::id();
    let chain = snap.chain(pid, DEPTH);
    if chain.contains(&me) {
        // one of the app's own terminals the frontend did not match: at least show the app
        lifecycle::show_main(app);
        return true;
    }
    imp::bring_forward(snap, &chain)
}

#[cfg(windows)]
mod imp {
    use super::super::reach::win::{self, Win};
    use super::Snapshot;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsIconic, IsWindowVisible, SW_RESTORE, SW_SHOW, SetForegroundWindow, ShowWindow,
    };

    pub fn bring_forward(snap: &Snapshot, chain: &[u32]) -> bool {
        let wins = win::windows();
        let name = |pid: u32| snap.get(pid).map(|p| p.name.as_str()).unwrap_or_default();
        let find = |pid: u32, console: bool| wins.iter().find(|w| w.pid == pid && w.console == console);
        for &pid in chain {
            if name(pid) == "explorer" {
                continue;
            }
            // a console window first (it may be hidden), then the process's main window
            if let Some(w) = find(pid, true).or_else(|| find(pid, false)) {
                bring(w.hwnd);
                return true;
            }
        }
        // last resort: any Windows Terminal window
        let terminal: Option<&Win> = wins.iter().find(|w| !w.console && name(w.pid) == "windowsterminal");
        match terminal {
            Some(w) => {
                bring(w.hwnd);
                true
            }
            None => false,
        }
    }

    /// Shows the window if hidden, restores it if minimized, and activates it.
    fn bring(hwnd: HWND) {
        // SAFETY: plain user32 calls on a window handle; a handle that died meanwhile only makes them fail.
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                ShowWindow(hwnd, SW_SHOW);
            }
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::super::reach::is_terminal_app;
    use super::Snapshot;
    use crate::core::spawn::{hidden_command, output_with_timeout};
    use std::path::{Path, PathBuf};
    use std::time::Duration;
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    pub fn bring_forward(snap: &Snapshot, chain: &[u32]) -> bool {
        for &pid in chain {
            if snap.get(pid).is_some_and(|p| is_terminal_app(&p.name))
                && let Some(bundle) = bundle_of(pid)
                && open(&["-a".as_ref(), bundle.as_os_str()])
            {
                return true;
            }
        }
        // last resort: Terminal.app, when it runs
        let terminal_runs = {
            let mut sys = System::new();
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
            sys.processes().values().any(|p| p.name() == "Terminal")
        };
        terminal_runs && open(&["-b".as_ref(), "com.apple.Terminal".as_ref()])
    }

    /// The outermost `.app` folder holding the process's executable (a helper app sits inside its app).
    fn bundle_of(pid: u32) -> Option<PathBuf> {
        let pid = Pid::from_u32(pid);
        let mut sys = System::new();
        let kind = ProcessRefreshKind::nothing().with_exe(UpdateKind::Always);
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, kind);
        let exe = sys.process(pid)?.exe()?.to_path_buf();
        exe.ancestors()
            .filter(|p| p.extension().is_some_and(|e| e == "app"))
            .last()
            .map(Path::to_path_buf)
    }

    /// `open` activates a running app (and its windows) without starting anything new.
    fn open(args: &[&std::ffi::OsStr]) -> bool {
        let mut cmd = hidden_command("/usr/bin/open");
        cmd.args(args);
        match output_with_timeout(&mut cmd, Duration::from_secs(5)) {
            Ok(out) => out.status.success(),
            Err(e) => {
                log::warn!("could not activate the terminal app: {e}");
                false
            }
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::Snapshot;

    pub fn bring_forward(_snap: &Snapshot, _chain: &[u32]) -> bool {
        false
    }
}
