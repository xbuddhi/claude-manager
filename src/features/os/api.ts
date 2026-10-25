// Public API of the OS integration feature (WP9). Other features may import this file only.
// Labels follow the platform; actions report failures themselves and resolve whether they worked.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { call } from "../../core/api";
import { bus, emit } from "../../core/bus";
import { describeError, log } from "../../core/log";
import { isMac, isWindows } from "../../core/platform";
import { message } from "../../ui/dialog";
import { toast } from "../../ui/toast";

declare module "../../core/api" {
  interface Commands {
    /** Existing absolute paths only; several folders open as one multi-root window. */
    open_in_code: { args: { paths: string[] }; result: null };
    /** Shows an existing file or folder selected in Explorer / Finder. */
    reveal_path: { args: { path: string }; result: null };
    /** Opens an existing folder (never a file) in Explorer / Finder. */
    open_path: { args: { dir: string }; result: null };
    /** Windows only; fails elsewhere. */
    explorer_menu_state: { args: undefined; result: boolean };
    explorer_menu_install: { args: undefined; result: null };
    explorer_menu_remove: { args: undefined; result: null };
  }
}

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

/** Opens files or folders in VS Code (several folders = one multi-root window). Missing ones are skipped. */
export async function openInCode(paths: readonly string[]): Promise<boolean> {
  const res = await call("open_in_code", { paths: [...paths] }, { quiet: true });
  if (res.ok) return true;
  // "VS Code was not found." gets a dialog, as in the Windows app
  if (res.error.code === "not_found") await message(res.error.message);
  else toast(res.error.message, { kind: "error" });
  return false;
}

/** Shows a file or folder selected in Explorer / Finder. */
export async function reveal(path: string): Promise<boolean> {
  return (await call("reveal_path", { path })).ok;
}

/** Opens a folder in Explorer / Finder. */
export async function openFolder(dir: string): Promise<boolean> {
  return (await call("open_path", { dir })).ok;
}

/** Opens PowerShell / Terminal in `dir` (no claude), in its own window. */
export async function terminalHere(dir: string): Promise<boolean> {
  if (!bus.handled("launch")) {
    toast(`${terminalHereLabel()} is not available yet.`);
    return false;
  }
  emit("launch", { dir, mode: "external", shellOnly: true });
  return true;
}

/** Whether the Explorer right-click menu is installed; null where there is none (macOS). */
export async function explorerMenuState(): Promise<boolean | null> {
  if (!isWindows()) return null;
  const res = await call("explorer_menu_state", undefined, { quiet: true });
  return res.ok ? res.value : null;
}

export async function explorerMenuInstall(): Promise<boolean> {
  const res = await call("explorer_menu_install");
  if (res.ok) {
    await message(
      "Explorer menu added\nRight-click any folder and pick 'Open Claude Code here', with one entry per profile. On Windows 11 it is under 'Show more options'.",
    );
  }
  return res.ok;
}

export async function explorerMenuRemove(): Promise<boolean> {
  const res = await call("explorer_menu_remove");
  if (res.ok)
    await message("Explorer menu removed\n'Open Claude Code here' is no longer in the folder right-click menu.");
  return res.ok;
}
