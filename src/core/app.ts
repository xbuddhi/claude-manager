// Startup: platform, settings and profiles first (features render from them), then the shell, keyboard and
// features, then the window is shown after the first paint (it is created hidden, so it never flashes
// empty). A feature can hold the first paint briefly with beforeShow(), e.g. to decide which screen to show.
// The environment check runs after the window is up.

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { closeBanner, showBanner } from "../ui/banner";
import { installTooltips } from "../ui/tooltip";
import { call } from "./api";
import { emit } from "./bus";
import { hasCommand, registerCommand, runCommand } from "./commands";
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

const SETUP_URL = "https://code.claude.com/docs/en/setup";
/** The longest the first paint waits for beforeShow() work. */
const SHOW_WAIT_MS = 1500;
const beforeShowWork: Promise<unknown>[] = [];

/**
 * Holds the window's first paint until `work` settles (all such work together waits at most 1.5 s).
 * Call it while mounting, for work that decides what the first screen shows (WP6: picker or main;
 * WP1: a warm cache). Rejections are ignored here: the feature reports its own errors.
 */
export function beforeShow(work: Promise<unknown>): void {
  beforeShowWork.push(work);
}

async function waitBeforeShow(): Promise<void> {
  if (!beforeShowWork.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      log.warn(`startup work took longer than ${SHOW_WAIT_MS} ms; showing the window anyway`);
      resolve();
    }, SHOW_WAIT_MS);
  });
  await Promise.race([Promise.allSettled(beforeShowWork), limit]);
  clearTimeout(timer);
}

/** Commands the foundation owns. Their ids match the native menu items (src-tauri/src/os/menu.rs). */
function registerCoreCommands() {
  registerCommand({ id: "search:focus", title: "Find", run: () => emit("search:focus") });
  registerCommand({ id: "refresh:full", title: "Refresh", run: () => emit("refresh:full") });
  registerCommand({ id: "help:logs", title: "Show Logs", run: () => void call("open_log_dir") });
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
  const actions = [{ label: "Setup guide", run: () => void call("open_url_https", { url: SETUP_URL }) }];
  // the Settings screen comes with the profiles feature (WP6); offered once it is registered
  if (hasCommand("app:settings")) actions.push({ label: "Settings", run: () => void runCommand("app:settings") });
  showBanner({
    id: "claude-missing",
    kind: "error",
    text: custom
      ? `The Claude path set in Settings does not exist\n${custom}`
      : "Claude Code was not found.\nInstall it or set its path in Settings.",
    actions,
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
    await Promise.all([initPlatform(), initSettings(), initProfiles()]);
    await initTitlebar();
    initShell();
    initViews();
    registerCoreCommands();
    await installKeyboard();
    mountFeatures();
    await waitBeforeShow();
  } catch (e) {
    // still show what did render: a hidden window with no error is worse than a partial one
    log.error(`startup failed: ${describeError(e)}`);
  }
  await showWindow();
  void checkEnvironment();
  store.select(
    (s) => s.settings.claudePath,
    () => void checkEnvironment(),
  );
}
