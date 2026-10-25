// OS integration (WP9): the parts that run in the page. The tray, native menu, Explorer menu and WebView2
// memory live in Rust (src-tauri/src/os); other features use ./api.ts.

import { describeError, log } from "../../core/log";
import { installOpenRequests } from "./wiring";

export function mount(): void {
  installOpenRequests().catch((e) => log.error(`open requests: ${describeError(e)}`));
}
