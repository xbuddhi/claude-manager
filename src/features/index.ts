// Every feature mounts here, one line each, inside the marked blocks. A feature package adds only its own
// import and mount line; it renders into its shell slot and talks to others through core/bus and the store.

// ---- feature imports (one line each) ----
import { mount as mountIndexData } from "./index-data";
import { mount as mountSessions } from "./sessions";
import { mount as mountSidebar } from "./sidebar";
import { mount as mountTerminals } from "./terminals";
// ---- end feature imports ----

export function mountFeatures(): void {
  // ---- feature mounts (one line each) ----
  mountIndexData();
  mountSidebar();
  mountSessions();
  mountTerminals();
  // ---- end feature mounts ----
}
