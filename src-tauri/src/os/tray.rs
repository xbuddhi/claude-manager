//! The tray icon (Windows) / menu bar icon (macOS) "Claude Sessions". It is there for the whole run, so a
//! window hidden by "Keep running" can always be brought back. Its menu items go through the one menu
//! event handler in `menu.rs`.

use super::menu::{NEW_SESSION, QUIT, SHOW_WINDOW};
use crate::core::lifecycle;
use tauri::AppHandle;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

const TRAY_ID: &str = "main";
const TOOLTIP: &str = "Claude Sessions";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, SHOW_WINDOW, "Show Claude Sessions", true, None::<&str>)?,
            &MenuItem::with_id(app, NEW_SESSION, "New session", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?,
        ],
    )?;
    let mac = cfg!(target_os = "macos");
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(TOOLTIP)
        .menu(&menu)
        // a menu bar icon opens its menu on click; a Windows tray icon shows the window instead
        .show_menu_on_left_click(mac)
        .on_tray_icon_event(|tray, event| {
            if shows_window(&event) {
                lifecycle::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = if mac {
            // a template image follows the menu bar's light and dark appearance
            builder.icon(template(icon)).icon_as_template(true)
        } else {
            builder.icon(icon.clone().to_owned())
        };
    }
    builder.build(app)?;
    lifecycle::set_tray_present(app);
    Ok(())
}

/// Left click or double-click on the icon (Windows; on macOS a click opens the menu).
fn shows_window(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } | TrayIconEvent::DoubleClick {
            button: MouseButton::Left,
            ..
        }
    )
}

/// The icon's shape in black: macOS draws template images in the menu bar's own colour.
fn template(icon: &Image<'_>) -> Image<'static> {
    Image::new_owned(silhouette(icon.rgba()), icon.width(), icon.height())
}

/// RGBA pixels with the colour removed and the alpha kept.
fn silhouette(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4).flat_map(|px| [0, 0, 0, px[3]]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silhouette_keeps_only_the_alpha() {
        let px = [10, 20, 30, 0, 200, 100, 50, 255, 1, 2, 3, 128];
        assert_eq!(silhouette(&px), vec![0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 128]);
    }
}
