// The only way features talk to the backend. Every command and event name is typed here (core) or in the
// feature that owns it, by declaration merging:
//
//   declare module "../../core/api" {
//     interface Commands { git_status: { args: { repo: string }; result: GitStatus } }
//     interface BackendEvents { "git-changed": { repo: string } }
//   }
//
// call() never throws: it returns a Result, logs failures, and shows a toast unless `quiet` is set.

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { AppError } from "../bindings/AppError";
import type { CloseRequest } from "../bindings/CloseRequest";
import type { EnvStatus } from "../bindings/EnvStatus";
import type { MenuEvent } from "../bindings/MenuEvent";
import type { OpenArgs } from "../bindings/OpenArgs";
import type { PlatformInfo } from "../bindings/PlatformInfo";
import type { Profile } from "../bindings/Profile";
import type { QuitDecision } from "../bindings/QuitDecision";
import type { Settings } from "../bindings/Settings";
import { toast } from "../ui/toast";
import { describeError, log } from "./log";

export interface Commands {
  get_settings: { args: undefined; result: Settings };
  /** Top-level keys replace; the whole result must be valid or nothing changes. */
  update_settings: { args: { patch: Record<string, unknown> }; result: Settings };
  list_profiles: { args: undefined; result: Profile[] };
  /** Clears the email cache and emits `profiles-changed`. */
  refresh_profiles: { args: undefined; result: Profile[] };
  env_status: { args: undefined; result: EnvStatus };
  platform_info: { args: undefined; result: PlatformInfo };
  app_quit_decision: { args: { decision: QuitDecision }; result: null };
}

export interface BackendEvents {
  "settings-changed": Settings;
  "profiles-changed": Profile[];
  /** The main window is shown first. Answer with `app_quit_decision`. */
  "app:close-requested": CloseRequest;
  /** Untrusted: validate every value. */
  "app:open-args": OpenArgs;
  menu: MenuEvent;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export interface CallOptions {
  /** Do not show a toast on failure (the caller shows the error itself). Failures are still logged. */
  quiet?: boolean;
}

type CallArgs<K extends keyof Commands> = Commands[K]["args"] extends undefined
  ? [args?: undefined, opts?: CallOptions]
  : [args: Commands[K]["args"], opts?: CallOptions];

/** Commands reject with `{code, message}` (bindings/AppError); anything else becomes an internal error. */
export function toAppError(e: unknown): AppError {
  if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
    return { code: e.code as AppError["code"], message: String(e.message) };
  }
  return { code: "internal", message: describeError(e) };
}

export async function call<K extends keyof Commands>(
  cmd: K,
  ...[args, opts]: CallArgs<K>
): Promise<Result<Commands[K]["result"]>> {
  try {
    const value = await invoke<Commands[K]["result"]>(cmd, args ?? {});
    return { ok: true, value };
  } catch (e) {
    const error = toAppError(e);
    log.error(`${cmd} failed: [${error.code}] ${error.message}`);
    if (!opts?.quiet) toast(error.message, { kind: "error" });
    return { ok: false, error };
  }
}

/** Listens to a backend event; a throwing handler is logged instead of breaking the listener. */
export async function listen<K extends keyof BackendEvents>(
  name: K,
  handler: (payload: BackendEvents[K]) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return tauriListen<BackendEvents[K]>(name, ({ payload }) => {
    try {
      handler(payload);
    } catch (e) {
      log.error(`handler for backend event "${name}" failed: ${describeError(e)}`);
    }
  });
}
