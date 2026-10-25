; NSIS installer hooks (WP9). Referenced from tauri.conf.json:
;   "bundle": { "windows": { "nsis": { "installerHooks": "windows/uninstall-hooks.nsh" } } }
;
; Removes the Explorer right-click menu "Open Claude Code here" (src-tauri/src/os/explorer_menu.rs).
; The app writes it to HKCU of the user who added it; a per-user install uninstalls as that user.
; The key names are shared with the old PowerShell app, whose menu goes too.
; An update runs the old uninstaller with /UPDATE ($UpdateMode = 1 in Tauri's template): keep the menu then.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeCode"
    DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeCode"
  ${EndIf}
!macroend
