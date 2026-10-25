// Public API of the OS integration feature (WP9). Other features may import this file only.
// The labels, copyText() and openUrlHttps() work now. The rest are stubs provided by WP9, which replaces
// their bodies only; until then they tell the user the action is not available yet and resolve false.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { call } from "../../core/api";
import { describeError, log } from "../../core/log";
import { isMac } from "../../core/platform";
import { toast } from "../../ui/toast";

/** For a file: "Show in Explorer" / "Reveal in Finder". */
export function revealLabel(): string {
  return isMac() ? "Reveal in Finder" : "Show in Explorer";
}

/** For a folder: "Open in Explorer" / "Show in Finder". */
export function folderLabel(): string {
  return isMac() ? "Show in Finder" : "Open in Explorer";
}

export function terminalHereLabel(): string {
  return isMac() ? "Open Terminal here" : "Open PowerShell here";
}

/** Where deleted files go: "Recycle Bin" / "Trash". */
export function trashName(): string {
  return isMac() ? "Trash" : "Recycle Bin";
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch (e) {
    log.error(`copy failed: ${describeError(e)}`);
    toast("Could not copy to the clipboard.", { kind: "error" });
    return false;
  }
}

/** Opens an https link in the default browser (anything else is refused). */
export async function openUrlHttps(url: string): Promise<boolean> {
  return (await call("open_url_https", { url })).ok;
}

function notYet(what: string): false {
  toast(`${what} is not available yet.`);
  return false;
}

/** Opens files or folders in VS Code (several folders = one multi-root window). Stub provided by WP9. */
export async function openInCode(_paths: readonly string[]): Promise<boolean> {
  return notYet("Opening VS Code");
}

/** Shows a file or folder selected in Explorer / Finder. Stub provided by WP9. */
export async function reveal(_path: string): Promise<boolean> {
  return notYet(revealLabel());
}

/** Opens a folder in Explorer / Finder. Stub provided by WP9. */
export async function openFolder(_dir: string): Promise<boolean> {
  return notYet(folderLabel());
}

/** Opens PowerShell / Terminal in `dir` (no claude). Stub provided by WP9. */
export async function terminalHere(_dir: string): Promise<boolean> {
  return notYet(terminalHereLabel());
}

/** Whether the Explorer right-click menu is installed; null where there is none (macOS). Stub provided by WP9. */
export async function explorerMenuState(): Promise<boolean | null> {
  return null;
}

/** Stub provided by WP9. */
export async function explorerMenuInstall(): Promise<boolean> {
  return notYet("The Explorer menu");
}

/** Stub provided by WP9. */
export async function explorerMenuRemove(): Promise<boolean> {
  return notYet("The Explorer menu");
}
