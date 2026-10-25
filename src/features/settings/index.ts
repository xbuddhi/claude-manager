// Settings (WP6): the Settings sheet, opened by the command app:settings (Cmd+, / Ctrl+,, the macOS menu
// item "Settings...", the profile popover). Running it again closes the sheet.

import { registerCommand } from "../../core/commands";
import { registerShortcut } from "../../core/keyboard";
import { closeSettings, isSettingsOpen, openSettings } from "./settings";

export function mount(): void {
  registerCommand({
    id: "app:settings",
    title: "Settings",
    run: () => (isSettingsOpen() ? closeSettings() : openSettings()),
  });
  registerShortcut({ id: "app:settings", keys: "CmdOrCtrl+," });
}
