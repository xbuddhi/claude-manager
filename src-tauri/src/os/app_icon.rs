//! The App icon setting (macOS): the app's own icon or one in a skin's colours, everywhere macOS shows it.
//! The images are built into the app (src/assets/app-icons, drawn by scripts/make-icons.mjs); the webview
//! names one, it never sends a path or image.
//!
//! Two places, as other apps with alternate icons do it:
//! - the running app's Dock tile (setApplicationIconImage), at once;
//! - the app's own bundle, as a custom icon (NSWorkspace setIcon:forFile:), so Finder, Spotlight, Launchpad
//!   and the Dock after quitting show it too. Only when the app runs from an .app it may write; the default
//!   icon removes the custom one, leaving the bundle as shipped. macOS keeps a custom icon as a file in the
//!   bundle, which a strict signature check (`codesign --verify --strict`) reports; the app still opens. An
//!   update replaces the bundle, and the next launch sets the icon again.
//!
//! Every window asks for the icon as it opens: a repeat within a run does nothing, and the bundle is written
//! only when its icon differs from the choice (a marker in the app's config folder names the variant last
//! set), so a usual launch touches no file.

use crate::core::error::AppResult;
use crate::core::types::AppIcon;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use tauri::AppHandle;

/// The icon applied in this run (every window asks as it opens).
static APPLIED: Mutex<Option<AppIcon>> = Mutex::new(None);

/// Name of the marker file in the app's config folder: the variant last set on the bundle.
const MARKER: &str = "app-icon";

/// The setting's name of a variant ("linear"), as the marker stores it.
fn name(icon: AppIcon) -> String {
    format!("{icon:?}").to_lowercase()
}

/// The .app holding `exe` (`<name>.app/Contents/MacOS/<binary>`); None for a bare binary (a dev build).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let bundle = exe.ancestors().nth(3)?;
    let macos = exe.parent()?;
    let ok = bundle.extension().is_some_and(|e| e == "app")
        && macos.file_name().is_some_and(|n| n == "MacOS")
        && macos.parent()?.file_name().is_some_and(|n| n == "Contents");
    ok.then(|| bundle.to_path_buf())
}

/// Whether the bundle must be written: the default removes a custom icon that is there; a variant is set
/// unless the bundle already has a custom icon and the marker says it is this one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn needs_write(has_custom: bool, marker: Option<&str>, icon: AppIcon) -> bool {
    match icon {
        AppIcon::Claude => has_custom,
        _ => !(has_custom && marker == Some(name(icon).as_str())),
    }
}

/// The PNG of a variant. The app's own icon is set as an image too, never left to the bundle: a binary run
/// outside an .app (a dev build) has no bundle icon, and the Dock would show the generic "exec" one.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn image(icon: AppIcon) -> &'static [u8] {
    match icon {
        AppIcon::Claude => include_bytes!("../../../src/assets/app-icons/claude.png"),
        AppIcon::Modern => include_bytes!("../../../src/assets/app-icons/modern.png"),
        AppIcon::Mono => include_bytes!("../../../src/assets/app-icons/mono.png"),
        AppIcon::Paper => include_bytes!("../../../src/assets/app-icons/paper.png"),
        AppIcon::Linear => include_bytes!("../../../src/assets/app-icons/linear.png"),
        AppIcon::Graphite => include_bytes!("../../../src/assets/app-icons/graphite.png"),
    }
}

/// Where the bundle's custom icon goes: the bundle, and the marker file to note the variant in.
#[cfg(target_os = "macos")]
struct BundleWrite {
    bundle: PathBuf,
    marker: Option<PathBuf>,
}

/// Runs on the main thread: the Dock tile, then the bundle when `write` says so.
#[cfg(target_os = "macos")]
fn apply(icon: AppIcon, write: Option<BundleWrite>) {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    let png = image(icon);
    // SAFETY: on the main thread (run_on_main_thread); NSData copies the bytes; initWithData: returns nil for
    // data it cannot read, and the icon is then left as it is
    unsafe {
        let data: Retained<AnyObject> =
            msg_send![class!(NSData), dataWithBytes: png.as_ptr().cast::<std::ffi::c_void>(), length: png.len()];
        let blank: Allocated<AnyObject> = msg_send![class!(NSImage), alloc];
        let picture: Option<Retained<AnyObject>> = msg_send![blank, initWithData: &*data];
        let Some(picture) = picture else {
            log::warn!("app icon {icon:?}: the image could not be read");
            return;
        };
        let app: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        let _: () = msg_send![&*app, setApplicationIconImage: &*picture];
        // the bundle: the variant as its custom icon, or none for the default (the bundle's own icon)
        let Some(BundleWrite { bundle, marker }) = write else {
            return;
        };
        let Ok(path) = std::ffi::CString::new(bundle.as_os_str().as_encoded_bytes()) else {
            return;
        };
        let path: Retained<AnyObject> = msg_send![class!(NSString), stringWithUTF8String: path.as_ptr()];
        let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
        let custom = (icon != AppIcon::Claude).then_some(&*picture);
        let done: bool = msg_send![&*workspace, setIcon: custom, forFile: &*path, options: 0usize];
        if !done {
            log::warn!("app icon {icon:?}: could not set the icon of {}", bundle.display());
            return;
        }
        let _: () = msg_send![&*workspace, noteFileSystemChanged: &*path];
        if let Some(marker) = marker {
            let noted = if icon == AppIcon::Claude {
                std::fs::remove_file(&marker).or_else(|e| match e.kind() {
                    std::io::ErrorKind::NotFound => Ok(()),
                    _ => Err(e),
                })
            } else {
                std::fs::write(&marker, name(icon))
            };
            if let Err(e) = noted {
                log::warn!("app icon marker {}: {e}", marker.display());
            }
        }
    }
}

/// The .app this process runs from, when it may write to it; None for a bare binary (a dev build) or a
/// read-only place (a disk image, an app translocated by Gatekeeper).
#[cfg(target_os = "macos")]
fn own_bundle() -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let bundle = bundle_of(&std::env::current_exe().ok()?)?;
    let c = std::ffi::CString::new(bundle.as_os_str().as_bytes()).ok()?;
    // SAFETY: a valid NUL-terminated path; access() only reads it
    let writable = unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0;
    writable.then_some(bundle)
}

/// What to write to the bundle for `icon`, or None when it already shows it (or cannot be written).
#[cfg(target_os = "macos")]
fn bundle_write(app: &AppHandle, icon: AppIcon) -> Option<BundleWrite> {
    use tauri::Manager;
    let bundle = own_bundle()?;
    let marker = app.path().app_config_dir().ok().map(|d| d.join(MARKER));
    let noted = marker.as_ref().and_then(|m| std::fs::read_to_string(m).ok());
    // macOS keeps a folder's custom icon in a file named "Icon\r" inside it
    let has_custom = bundle.join("Icon\r").exists();
    needs_write(has_custom, noted.as_deref().map(str::trim), icon).then_some(BundleWrite { bundle, marker })
}

// ---- commands ----

/// Shows this icon for the app (macOS; elsewhere nothing happens). A repeat within a run does nothing.
#[tauri::command]
pub async fn set_app_icon(app: AppHandle, icon: AppIcon) -> AppResult<()> {
    {
        let mut applied = APPLIED.lock().unwrap_or_else(PoisonError::into_inner);
        if *applied == Some(icon) {
            return Ok(());
        }
        *applied = Some(icon);
    }
    #[cfg(target_os = "macos")]
    {
        // the file checks happen here, off the main thread; only the AppKit calls go to it
        let write = bundle_write(&app, icon);
        if let Err(e) = app.run_on_main_thread(move || apply(icon, write)) {
            // not applied: let the next request try again
            *APPLIED.lock().unwrap_or_else(PoisonError::into_inner) = None;
            return Err(e.into());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_has_an_image() {
        for icon in [
            AppIcon::Claude,
            AppIcon::Modern,
            AppIcon::Mono,
            AppIcon::Paper,
            AppIcon::Linear,
            AppIcon::Graphite,
        ] {
            assert_eq!(&image(icon)[..8], b"\x89PNG\r\n\x1a\n");
        }
    }

    #[test]
    fn finds_the_bundle_of_an_app_binary_only() {
        let app = Path::new("/Applications/Claude Manager.app");
        assert_eq!(
            bundle_of(&app.join("Contents/MacOS/claude-manager")).as_deref(),
            Some(app)
        );
        // a dev build is a bare binary
        assert_eq!(bundle_of(Path::new("/src/target/debug/claude-manager")), None);
        // something else three levels up an .app
        assert_eq!(bundle_of(&app.join("Contents/Resources/tool")), None);
        assert_eq!(bundle_of(Path::new("claude-manager")), None);
    }

    #[test]
    fn writes_the_bundle_only_when_its_icon_differs() {
        // the default: remove a custom icon, else nothing to do
        assert!(needs_write(true, None, AppIcon::Claude));
        assert!(!needs_write(false, Some("linear"), AppIcon::Claude));
        // a variant: set unless that one is already there
        assert!(!needs_write(true, Some("linear"), AppIcon::Linear));
        assert!(needs_write(true, Some("mono"), AppIcon::Linear));
        assert!(needs_write(false, Some("linear"), AppIcon::Linear));
        assert!(needs_write(true, None, AppIcon::Linear));
        assert_eq!(name(AppIcon::Graphite), "graphite");
    }
}
