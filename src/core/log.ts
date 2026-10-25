// Frontend logging into the app log file (tauri-plugin-log), with the console as the fallback outside Tauri
// (unit tests, a plain browser on the Vite dev server).

import { isTauri } from "@tauri-apps/api/core";
import { debug, error, info, warn } from "@tauri-apps/plugin-log";

const sinks = { error, warn, info, debug };
type Level = keyof typeof sinks;

function write(level: Level, message: string) {
  if (!isTauri()) {
    console[level](message);
    return;
  }
  // logging must never throw into the caller, and a failed log write has nowhere better to go
  sinks[level](message).catch(() => console[level](message));
}

export const log = {
  error: (message: string) => write("error", message),
  warn: (message: string) => write("warn", message),
  info: (message: string) => write("info", message),
  debug: (message: string) => write("debug", message),
};

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack ?? e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String(e.message);
  return String(e);
}

/** Sends uncaught errors and unhandled promise rejections to the log file. */
export function captureGlobalErrors(): void {
  window.addEventListener("error", (e) => log.error(`uncaught: ${describeError(e.error ?? e.message)}`));
  window.addEventListener("unhandledrejection", (e) => log.error(`unhandled rejection: ${describeError(e.reason)}`));
}
