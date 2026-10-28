//! The Dock menu (macOS): New Session and New Window under the window list macOS puts there itself.
//!
//! Tauri has no API for it, so the app delegate (tao's) gets an `applicationDockMenu:` method that returns
//! a muda menu. muda is the menu library Tauri uses: clicks arrive in [`super::menu::on_menu_event`] like
//! the menu bar's. New Session uses the tray's id: a Dock click may leave the app unfocused, and
//! `session:new` waits for a focused window.

use super::menu::{NEW_WINDOW, TRAY_NEW_SESSION};
use muda::{ContextMenu, Menu, MenuItem};
use objc2::ffi::class_addMethod;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{class, msg_send, sel};
use std::cell::OnceCell;

thread_local! {
    /// Built once on the main thread, the only thread AppKit asks for it on.
    static MENU: OnceCell<Menu> = const { OnceCell::new() };
}

/// Builds the menu and hands it to the Dock. Runs in `setup`, on the main thread.
pub fn install() -> Result<(), muda::Error> {
    let menu = Menu::with_items(&[
        &MenuItem::with_id(TRAY_NEW_SESSION, "New Session", true, None),
        &MenuItem::with_id(NEW_WINDOW, "New Window", true, None),
    ])?;
    MENU.with(|m| m.set(menu)).ok();
    // SAFETY: on the main thread after launch; tao's delegate class has no applicationDockMenu: of its own
    // (class_addMethod would leave one alone), and the type encoding matches `dock_menu`
    unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: *mut AnyObject = msg_send![app, delegate];
        let Some(delegate) = delegate.as_ref() else {
            log::warn!("no app delegate; the Dock menu is not installed");
            return Ok(());
        };
        let imp: Imp = std::mem::transmute(dock_menu as extern "C-unwind" fn(_, _, _) -> _);
        let cls = delegate.class() as *const AnyClass as *mut AnyClass;
        if !class_addMethod(cls, sel!(applicationDockMenu:), imp, c"@@:@".as_ptr()).as_bool() {
            log::warn!("the app delegate already has a Dock menu; ours is not installed");
        }
    }
    Ok(())
}

/// `- (NSMenu *)applicationDockMenu:(NSApplication *)sender`
extern "C-unwind" fn dock_menu(_this: &AnyObject, _cmd: Sel, _sender: *mut AnyObject) -> *mut AnyObject {
    MENU.with(|m| m.get().map_or(std::ptr::null_mut(), |menu| menu.ns_menu().cast()))
}
