//! The taskbar Jump List (Windows): New Session and New Window when the taskbar button is right-clicked,
//! like the Dock menu on macOS (`dock.rs`).
//!
//! A Jump List task can only start a program, so each one runs this app with `--task <menu id>`. The
//! single-instance plugin hands that to the running app (`lifecycle::on_second_instance`), which handles it
//! like the tray menu item with the same id. Started with no app running, the task just opens the app.

use super::args::TASK_FLAG;
use super::menu::{NEW_WINDOW, TRAY_NEW_SESSION};
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantClear};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, SHStrDupW, ShellLink,
};
use windows::core::{HSTRING, Interface};

const TASKS: [(&str, &str); 2] = [(TRAY_NEW_SESSION, "New Session"), (NEW_WINDOW, "New Window")];

/// Writes the Jump List on a background thread (it touches the disk). Runs in `setup`; the list stays
/// with the app's taskbar button, so writing it at each start only keeps the exe path current.
pub fn install() {
    let exe = match std::env::current_exe() {
        Ok(exe) => HSTRING::from(exe.as_os_str()),
        Err(e) => {
            log::error!("could not create the Jump List: {e}");
            return;
        }
    };
    std::thread::spawn(move || {
        // SAFETY: COM is initialized and uninitialized on this thread only
        unsafe {
            if let Err(e) = CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() {
                log::error!("could not create the Jump List: {e}");
                return;
            }
            if let Err(e) = write(&exe) {
                log::error!("could not create the Jump List: {e}");
            }
            CoUninitialize();
        }
    });
}

unsafe fn write(exe: &HSTRING) -> windows::core::Result<()> {
    unsafe {
        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0u32;
        // the items the user removed: tasks cannot be removed, so there is nothing to honour
        let _removed: IObjectArray = list.BeginList(&mut slots)?;
        let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
        for (id, title) in TASKS {
            tasks.AddObject(&link(exe, id, title)?)?;
        }
        list.AddUserTasks(&tasks.cast::<IObjectArray>()?)?;
        list.CommitList()
    }
}

/// A shell link that starts the app with `--task <id>`, titled `title`.
unsafe fn link(exe: &HSTRING, id: &str, title: &str) -> windows::core::Result<IShellLinkW> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(exe)?;
        link.SetArguments(&HSTRING::from(format!("{TASK_FLAG} {id}")))?;
        link.SetIconLocation(exe, 0)?;
        // a task shows its PKEY_Title. A VT_LPWSTR PROPVARIANT owns its string, which COM frees with
        // CoTaskMemFree, so it must come from the COM allocator (SHStrDupW, as InitPropVariantFromString
        // does); a string from Rust's allocator corrupts the heap (STATUS_HEAP_CORRUPTION at startup)
        let mut value = PROPVARIANT::default();
        (*value.Anonymous.Anonymous).vt = VT_LPWSTR;
        (*value.Anonymous.Anonymous).Anonymous.pwszVal = SHStrDupW(&HSTRING::from(title))?;
        let store: IPropertyStore = link.cast()?;
        let set = store.SetValue(&PKEY_Title, &value).and_then(|()| store.Commit());
        PropVariantClear(&mut value)?;
        set?;
        Ok(link)
    }
}
