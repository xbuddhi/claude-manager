// Startup: platform and settings first (features render from them), then the shell, keyboard and features,
// then the window is shown after the first paint (it is created hidden, so it never flashes empty).
// Profiles and the environment check load after the window is up.

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeBanner, showBanner } from "../ui/banner";
import { installTooltips } from "../ui/tooltip";
import { call } from "./api";
import { emit } from "./bus";
import { registerCommand } from "./commands";
import { nextFrame } from "./dom";
import { installKeyboard, registerShortcut } from "./keyboard";
import { captureGlobalErrors, describeError, log } from "./log";
import { initPlatform } from "./platform";
import { initProfiles } from "./profiles";
import { initSettings, settings } from "./settings";
import { initShell } from "./shell";
import { store } from "./store";
import { initTitlebar } from "./titlebar";
import { initViews } from "./views";

/** Commands the foundation owns. Their ids match the native menu items (src-tauri/src/os/menu.rs). */
function registerCoreCommands() {
  registerCommand({ id: "search:focus", title: "Find", run: () => emit("search:focus") });
  registerCommand({ id: "refresh:full", title: "Refresh", run: () => emit("refresh:full") });
  registerShortcut({ id: "search:focus", keys: "CmdOrCtrl+F" });
  registerShortcut({ id: "refresh:full", keys: ["F5", "Cmd+R"] });
}

/** Claude Code missing makes the app unable to start sessions: say so up front, not on the first click. */
async function checkEnvironment() {
  const res = await call("env_status", undefined, { quiet: true });
  if (!res.ok) return;
  if (res.value.claudePath) {
    closeBanner("claude-missing");
    return;
  }
  const custom = settings().claudePath;
  showBanner({
    id: "claude-missing",
    kind: "error",
    text: custom
      ? `The Claude path set in Settings does not exist\n${custom}`
      : "Claude Code was not found on this computer\nInstall Claude Code, then restart Claude Manager. You can browse sessions, but not start them.",
  });
}

async function showWindow() {
  await nextFrame();
  document.documentElement.classList.add("ready");
  if (!isTauri()) return;
  try {
    await getCurrentWindow().show();
  } catch (e) {
    log.error(`showing the window failed: ${describeError(e)}`);
  }
}

export async function start(mountFeatures: () => void): Promise<void> {
  captureGlobalErrors();
  try {
    installTooltips();
    await Promise.all([initPlatform(), initSettings()]);
    await initTitlebar();
    initShell();
    initViews();
    registerCoreCommands();
    await installKeyboard();
    mountFeatures();
  } catch (e) {
    // still show what did render: a hidden window with no error is worse than a partial one
    log.error(`startup failed: ${describeError(e)}`);
  }
  await showWindow();
  void initProfiles();
  void checkEnvironment();
  store.select(
    (s) => s.settings.claudePath,
    () => void checkEnvironment(),
  );
}
