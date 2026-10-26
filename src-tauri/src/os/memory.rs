//! WebView2 memory (Windows): while an app window is minimized or hidden, its WebView2 is asked to use less
//! memory, and back to normal when it gets focus. Only then: a window that is merely unfocused (say, while
//! you work in another of the app's windows) is still on screen, and the low level makes it sluggish.
//! Needs WebView2 runtime 114 or later; older runtimes are left alone.

#[cfg(windows)]
use tauri::Manager;
use tauri::{Builder, Wry};

/// Adds a small plugin that watches the app windows' focus.
pub fn attach(builder: Builder<Wry>) -> Builder<Wry> {
    #[cfg(windows)]
    let builder = builder.plugin(
        tauri::plugin::Builder::<Wry, ()>::new("os-memory")
            .on_event(|app, event| {
                if let tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Focused(focused),
                    ..
                } = event
                    && crate::core::windows::is_app_window(label)
                {
                    let out_of_sight = || {
                        app.get_webview_window(label)
                            .is_some_and(|w| w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true))
                    };
                    win::set_low(app, label, !focused && out_of_sight());
                }
            })
            .build(),
    );
    builder
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use tauri::{AppHandle, Manager};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2,
        ICoreWebView2_19,
    };
    use windows_sys::core::GUID;

    /// IID of ICoreWebView2_19, the interface with SetMemoryUsageTargetLevel.
    const IID_ICOREWEBVIEW2_19: GUID = GUID::from_u128(0x6921f954_79b0_437f_a997_c85811897c68);

    /// The first entry of every COM interface's vtable (the only one used here).
    #[repr(C)]
    struct IUnknownVtbl {
        query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    }

    pub fn set_low(app: &AppHandle, label: &str, low: bool) {
        let Some(window) = app.get_webview_window(label) else {
            return;
        };
        let result = window.with_webview(move |webview| {
            // SAFETY: called on the UI thread with the live controller of this window's WebView2
            let outcome = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|e| e.to_string())
                    .and_then(|core| set_level(&core, low))
            };
            if let Err(e) = outcome {
                log::debug!("WebView2 memory target not changed: {e}");
            }
        });
        if let Err(e) = result {
            log::debug!("WebView2 memory target not changed: {e}");
        }
    }

    /// QueryInterface by hand: `webview2-com` does not re-export the `windows-core` trait that would do it.
    ///
    /// SAFETY: `core` must be a live ICoreWebView2. Interface types are a single non-null COM pointer
    /// (`#[repr(transparent)]`), so copying one out reads that pointer without touching its reference
    /// count, and a pointer returned by QueryInterface (which holds one reference) is a valid owned value.
    unsafe fn set_level(core: &ICoreWebView2, low: bool) -> Result<(), String> {
        unsafe {
            let raw: *mut c_void = std::mem::transmute_copy(core);
            let vtbl = *(raw as *const *const IUnknownVtbl);
            let mut out: *mut c_void = std::ptr::null_mut();
            let hr = ((*vtbl).query_interface)(raw, &IID_ICOREWEBVIEW2_19, &mut out);
            if hr < 0 || out.is_null() {
                return Err(format!("this WebView2 runtime has no memory target (0x{hr:08X})"));
            }
            // owns the reference QueryInterface added; dropping it releases it
            let core19: ICoreWebView2_19 = std::mem::transmute::<*mut c_void, ICoreWebView2_19>(out);
            let level = if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            core19.SetMemoryUsageTargetLevel(level).map_err(|e| e.to_string())
        }
    }
}
