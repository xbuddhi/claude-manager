//! The tray icon (Windows) / menu bar icon (macOS) "Claude Manager". It is there for the whole run, so a
//! window hidden by "Keep running" can always be brought back. Its menu items go through the one menu
//! event handler in `menu.rs`.

use super::menu::{NEW_WINDOW, QUIT, SHOW_WINDOW, TRAY_NEW_SESSION};
use crate::core::lifecycle;
use tauri::AppHandle;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

const TRAY_ID: &str = "main";
const TOOLTIP: &str = "Claude Manager";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, SHOW_WINDOW, "Show Claude Manager", true, None::<&str>)?,
            &MenuItem::with_id(app, TRAY_NEW_SESSION, "New session", true, None::<&str>)?,
            &MenuItem::with_id(app, NEW_WINDOW, "New window", true, None::<&str>)?,
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
    if mac {
        // a template image follows the menu bar's light and dark appearance
        builder = builder.icon(menu_bar_template()).icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone().to_owned());
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

/// The menu bar icon: black and alpha only, drawn by scripts/make-icons.mjs (trayLayers). The app icon
/// cannot serve: its opaque rounded square would turn into a solid blob.
fn menu_bar_template() -> Image<'static> {
    tauri::include_image!("icons/tray-template.png")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_bar_icon_is_a_black_template_with_shape() {
        let icon = menu_bar_template();
        assert_eq!((icon.width(), icon.height()), (44, 44));
        let px: Vec<&[u8]> = icon.rgba().chunks_exact(4).collect();
        assert!(px.iter().all(|p| p[..3] == [0, 0, 0]));
        // transparent around the mark, not one filled square
        assert!(px.iter().any(|p| p[3] == 0) && px.iter().any(|p| p[3] == 255));
    }
}
