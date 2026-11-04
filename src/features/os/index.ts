// OS integration (WP9): the parts that run in the page. The tray, native menu, Explorer menu and WebView2
// memory live in Rust (src-tauri/src/os); other features use ./api.ts.

import { isTauri } from "@tauri-apps/api/core";
import type { AppIcon } from "../../bindings/AppIcon";
import { call } from "../../core/api";
import { describeError, log } from "../../core/log";
import { isMac } from "../../core/platform";
import { store } from "../../core/store";
import { installOpenRequests } from "./wiring";

declare module "../../core/api" {
  interface Commands {
    /** Shows this App icon in the Dock (macOS). */
    set_app_icon: { args: { icon: AppIcon }; result: null };
  }
}

export function mount(): void {
  installOpenRequests().catch((e) => log.error(`open requests: ${describeError(e)}`));
  // the App icon setting: the Dock shows it from launch, and changes at once
  if (isTauri() && isMac()) {
    store.select(
      (s) => s.settings.appIcon,
      (icon) => void call("set_app_icon", { icon }, { quiet: true }),
      {
        immediate: true,
      },
    );
  }
}
