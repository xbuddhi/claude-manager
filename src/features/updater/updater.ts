// In-app updates: check the release's latest.json (tauri-plugin-updater), show "Update available" as a
// banner, and on "Restart to update" download with progress, install and relaunch. The backend registers
// the plugin only when a release endpoint and public key are configured (src-tauri/src/updater); until then
// the check fails with "plugin not found" and the feature stays silent ("disabled").

import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { describeError, log } from "../../core/log";
import { store, type TermInfo } from "../../core/store";
import { closeBanner, showBanner } from "../../ui/banner";
import { ask } from "../../ui/dialog";
import type { UpdateCheck } from "./api";

export const BANNER_ID = "update";
/** First check after startup, so it never competes with the first paint and the session scan. */
export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;

let disabled = false;
let pending: Update | null = null;
let inFlight: Promise<UpdateCheck> | null = null;
let installing = false;
/** Version the timer last announced; the daily check does not bring back a banner the user dismissed. */
let announced: string | null = null;

/** An error as one line for the user (plugin errors arrive as plain strings). */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : describeError(e);
}

/** The updater plugin is not registered (no release endpoint configured) or not permitted. */
export function isUnavailable(e: unknown): boolean {
  return /plugin\b.*\bnot found|not allowed/i.test(errorText(e));
}

/** Terminals whose claude still runs; restarting the app ends them. */
export function liveTerminals(terms: TermInfo[]): number {
  return terms.filter((t) => !t.exited && t.ptyId !== null).length;
}

export function restartQuestion(version: string, live: number): string {
  const sessions = live === 1 ? "1 Claude session that is running" : `${live} Claude sessions that are running`;
  return `Restart to update to v${version}?\nRestarting ends ${sessions} inside the app. The sessions stay saved and can be resumed after the update.`;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** Banner text while the update downloads. */
export function progressText(version: string, received: number, total: number | undefined): string {
  const amount =
    total && total > 0 ? `${Math.min(100, Math.floor((received / total) * 100))}%` : received > 0 ? mb(received) : "";
  return `Downloading update v${version}…${amount ? ` ${amount}` : ""}\nClaude Manager restarts when it is installed.`;
}

function showAvailable(update: Update) {
  showBanner({
    id: BANNER_ID,
    kind: "info",
    text: `Update available: v${update.version}\nYou have v${update.currentVersion}.`,
    actions: [{ label: "Restart to update", run: () => void restartToUpdate(update) }],
  });
}

function showFailed(update: Update, message: string) {
  showBanner({
    id: BANNER_ID,
    kind: "warning",
    text: `The update to v${update.version} could not be installed.\n${message}`,
    actions: [{ label: "Try again", run: () => void restartToUpdate(update) }],
  });
}

async function runCheck(fromTimer: boolean): Promise<UpdateCheck> {
  if (disabled || !isTauri()) return { kind: "disabled" };
  if (installing && pending) return { kind: "available", version: pending.version };
  let update: Update | null;
  try {
    update = await check({ timeout: CHECK_TIMEOUT_MS });
  } catch (e) {
    if (isUnavailable(e)) {
      disabled = true;
      log.info("updates are disabled in this build");
      return { kind: "disabled" };
    }
    const message = errorText(e);
    log.warn(`update check failed: ${message}`);
    return { kind: "failed", message };
  }
  // a newer check replaces the previous result; release the old one in the backend
  if (pending && pending !== update) void pending.close().catch(() => {});
  pending = update;
  if (!update) {
    closeBanner(BANNER_ID);
    return { kind: "current" };
  }
  log.info(`update available: v${update.version} (running v${update.currentVersion})`);
  if (!fromTimer || announced !== update.version) showAvailable(update);
  announced = update.version;
  return { kind: "available", version: update.version };
}

/** One check at a time: a second caller shares the running one. */
export function checkForUpdate(fromTimer = false): Promise<UpdateCheck> {
  inFlight ??= runCheck(fromTimer).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export async function restartToUpdate(update: Update): Promise<void> {
  if (installing) return;
  const live = liveTerminals(store.get().terminals);
  if (live > 0 && !(await ask(restartQuestion(update.version, live), "Restart", "warning"))) return;
  installing = true;
  let received = 0;
  let total: number | undefined;
  let shown = "";
  const render = () => {
    const text = progressText(update.version, received, total);
    if (text === shown) return;
    shown = text;
    showBanner({ id: BANNER_ID, kind: "info", text, dismissible: false });
  };
  render();
  try {
    await update.downloadAndInstall((ev: DownloadEvent) => {
      if (ev.event === "Started") total = ev.data.contentLength;
      else if (ev.event === "Progress") received += ev.data.chunkLength;
      else
        showBanner({ id: BANNER_ID, kind: "info", text: `Installing update v${update.version}…`, dismissible: false });
      if (ev.event !== "Finished") render();
    });
    // Windows: the installer has already ended this process. macOS: the new bundle is in place; start it.
    log.info(`update v${update.version} installed; relaunching`);
    await relaunch();
  } catch (e) {
    installing = false;
    const message = errorText(e);
    log.error(`update to v${update.version} failed: ${message}`);
    showFailed(update, message);
  }
}

/** Checks shortly after startup and then once a day. Returns a function that stops the timers (tests). */
export function startChecks(): () => void {
  const first = setTimeout(() => void checkForUpdate(true), FIRST_CHECK_MS);
  const daily = setInterval(() => {
    if (disabled) clearInterval(daily);
    else void checkForUpdate(true);
  }, CHECK_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(daily);
  };
}

/** Test hook: forget everything between tests. */
export function resetForTests(): void {
  disabled = false;
  pending = null;
  inFlight = null;
  installing = false;
  announced = null;
}
