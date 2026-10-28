//! Finish notifications: on each live tick, a session that stops working shows "Claude finished", and one
//! that ends while working shows "Claude session ended". Nothing is shown with `settings.notify` off, or
//! while the user watches that session (its window focused and its tab in front there). Clicking a
//! notification shows the window in front and switches to the session (`notify:clicked`, handled by the
//! live frontend, which finds its tab in any window).

use crate::core::error::{AppResult, lock};
use crate::core::types::LiveSession;
use crate::core::{events, lifecycle, settings, windows};
use crate::live::snapshot::Snapshot;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tauri::{App, AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;
use ts_rs::TS;

/// Notifications whose click can still be matched to their session.
const REMEMBERED: usize = 32;
/// Ancestors of a session's process searched for the active tab's process.
const DEPTH: usize = 7;

/// Payload of `notify:clicked`.
#[derive(Serialize, TS, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotifyClicked {
    pub session_id: String,
}

#[derive(Default)]
pub struct Notifier(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// Working (level 2) sessions of the previous tick, by id: only those can finish.
    prev: HashMap<String, LiveSession>,
    /// Process of the terminal tab in front of each window, by window label (reported by the frontend).
    active_pids: HashMap<String, u32>,
    shown: VecDeque<(i32, String)>,
    next_id: i32,
}

pub fn init(app: &mut App) -> AppResult<()> {
    app.manage(Notifier::default());
    let handle = app.handle().clone();
    let registered = app.notification().on_action(move |performed| {
        if performed.action_id() != "tap" {
            return;
        }
        let id = performed.notification().map(|n| n.id());
        let session = id.and_then(|id| {
            let notifier = handle.state::<Notifier>();
            let st = lock(&notifier.0);
            st.shown.iter().find(|(n, _)| *n == id).map(|(_, s)| s.clone())
        });
        let front = lifecycle::show_front(&handle);
        if let Some(session_id) = session
            && let Some(front) = front
            && let Err(e) = handle.emit_to(front.label(), events::NOTIFY_CLICKED, NotifyClicked { session_id })
        {
            log::error!("could not report a notification click: {e}");
        }
    });
    if let Err(e) = registered {
        log::warn!("notification clicks will not be reported: {e}");
    }
    Ok(())
}

/// A session that stopped working since the last tick.
#[derive(Debug, PartialEq, Eq)]
pub struct Finished {
    pub session_id: String,
    pub pid: u32,
    pub cwd: Option<String>,
    /// Gone entirely (not just idle).
    pub ended: bool,
}

/// Sessions that were working (level 2) and now are idle or gone.
pub fn finished(prev: &HashMap<String, LiveSession>, now: &[LiveSession]) -> Vec<Finished> {
    let mut out: Vec<Finished> = prev
        .values()
        .filter(|was| was.level == 2)
        .filter_map(|was| {
            let current = now.iter().find(|s| s.session_id == was.session_id);
            if current.is_some_and(|s| s.level == 2) {
                return None;
            }
            let info = current.unwrap_or(was);
            Some(Finished {
                session_id: was.session_id.clone(),
                pid: info.pid,
                cwd: info.cwd.clone(),
                ended: current.is_none(),
            })
        })
        .collect();
    out.sort_by(|a, b| a.session_id.cmp(&b.session_id));
    out
}

/// Title and body: `<label, else folder name, else "Claude session">\n<folder name>`.
pub fn message(label: Option<String>, cwd: Option<&str>, ended: bool) -> (String, String) {
    let title = if ended {
        "Claude session ended"
    } else {
        "Claude finished"
    };
    let folder = cwd.and_then(leaf);
    let label = label
        .filter(|l| !l.trim().is_empty())
        .or_else(|| folder.clone())
        .unwrap_or_else(|| "Claude session".into());
    let body = match folder {
        Some(f) => format!("{label}\n{f}"),
        None => label,
    };
    (title.into(), body)
}

/// Last component of a path in either separator style.
fn leaf(path: &str) -> Option<String> {
    path.rsplit(['/', '\\']).find(|s| !s.is_empty()).map(str::to_string)
}

/// Runs after each live scan, also while the profile picker is shown.
pub fn on_tick(app: &AppHandle, sessions: &[LiveSession], snap: &Snapshot) {
    let notifier = app.state::<Notifier>();
    let enabled = settings::with(app, |s| s.notify);
    let (prev, active_pids) = {
        let mut st = lock(&notifier.0);
        if !enabled {
            st.prev.clear();
            return;
        }
        let mut working = sessions.iter().filter(|s| s.level == 2).peekable();
        // nothing was or is working: nothing to remember
        if st.prev.is_empty() && working.peek().is_none() {
            return;
        }
        let now = working.map(|s| (s.session_id.clone(), s.clone())).collect();
        (std::mem::replace(&mut st.prev, now), st.active_pids.clone())
    };
    let done = finished(&prev, sessions);
    if done.is_empty() {
        return;
    }
    // the tab in front of the focused window (none when another app has the focus)
    let active_pid = windows::all(app)
        .into_iter()
        .find(|w| w.is_focused().unwrap_or(false))
        .and_then(|w| active_pids.get(w.label()).copied());
    for f in done {
        let watching = active_pid.is_some_and(|a| a == f.pid || snap.chain(f.pid, DEPTH).contains(&a));
        if watching {
            continue;
        }
        let label = crate::sessions::label_for(app, &f.session_id);
        let (title, body) = message(label, f.cwd.as_deref(), f.ended);
        show(app, &f.session_id, &title, &body);
    }
}

fn show(app: &AppHandle, session_id: &str, title: &str, body: &str) {
    let notifier = app.state::<Notifier>();
    let id = {
        let mut st = lock(&notifier.0);
        st.next_id = st.next_id.checked_add(1).unwrap_or(1);
        let id = st.next_id;
        st.shown.push_back((id, session_id.to_string()));
        if st.shown.len() > REMEMBERED {
            st.shown.pop_front();
        }
        id
    };
    let shown = app.notification().builder().id(id).title(title).body(body).show();
    if let Err(e) = shown {
        log::warn!("could not show a notification: {e}");
    }
}

// ---- commands ----

/// The process of the terminal tab in front of the calling window (null = no tab in front), so
/// notifications for the session the user is watching are skipped.
#[tauri::command]
pub async fn set_active_terminal_pid(
    window: WebviewWindow,
    notifier: State<'_, Notifier>,
    pid: Option<u32>,
) -> AppResult<()> {
    let mut st = lock(&notifier.0);
    match pid {
        Some(pid) => st.active_pids.insert(window.label().to_string(), pid),
        None => st.active_pids.remove(window.label()),
    };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, level: u8, cwd: Option<&str>) -> LiveSession {
        LiveSession {
            session_id: id.into(),
            pid: 7,
            level,
            cwd: cwd.map(str::to_string),
            profile: "/h/.claude".into(),
            reachable: true,
        }
    }

    #[test]
    fn detects_finished_and_ended_sessions() {
        let prev: HashMap<String, LiveSession> = [
            s("a", 2, Some("C:\\x")),
            s("b", 2, Some("/u/y")),
            s("c", 1, None),
            s("d", 2, None),
        ]
        .into_iter()
        .map(|x| (x.session_id.clone(), x))
        .collect();
        let now = [s("a", 1, Some("C:\\x")), s("d", 2, None)];
        let got = finished(&prev, &now);
        assert_eq!(
            got,
            [
                Finished {
                    session_id: "a".into(),
                    pid: 7,
                    cwd: Some("C:\\x".into()),
                    ended: false
                },
                // gone while working: its last known folder is kept
                Finished {
                    session_id: "b".into(),
                    pid: 7,
                    cwd: Some("/u/y".into()),
                    ended: true
                },
            ]
        );
        assert!(finished(&HashMap::new(), &now).is_empty());
    }

    #[test]
    fn builds_the_message() {
        assert_eq!(
            message(Some("Fix the build".into()), Some("C:\\code\\app\\"), false),
            ("Claude finished".into(), "Fix the build\napp".into())
        );
        assert_eq!(
            message(None, Some("/Users/me/web"), true),
            ("Claude session ended".into(), "web\nweb".into())
        );
        assert_eq!(message(Some(" ".into()), None, false).1, "Claude session");
    }
}
