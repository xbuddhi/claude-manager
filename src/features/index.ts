// Every feature mounts here. A work package adds its import and mount lines directly under its own marker
// in the two blocks below, and never edits a marker or another package's lines, so packages merge without
// conflicts. A feature renders into its shell slot and talks to others through core/bus and the store.

// ---- feature imports ----
// WP1 index-data
import { mount as mountIndexData } from "./index-data";

// WP2 terminals
import { mount as mountTerminals } from "./terminals";

// WP3 live
import { mount as mountLive } from "./live";

// WP4 sidebar
import { mount as mountSidebar } from "./sidebar";

// WP5 sessions + search
import { mount as mountSearch } from "./search";
import { mount as mountSessions } from "./sessions";

// WP6 profiles + settings
import { mount as mountProfiles } from "./profiles";
import { mount as mountSettings } from "./settings";

// WP7 usage
import { mount as mountUsage } from "./usage";

// WP8 git

// WP9 os
import { mount as mountOs } from "./os";

// WP10 updater

// ---- end feature imports ----

export function mountFeatures(): void {
  // ---- feature mounts (order is mount order) ----
  // WP1 index-data
  mountIndexData();
  // WP2 terminals
  mountTerminals();
  // WP3 live
  mountLive();
  // WP4 sidebar
  mountSidebar();
  // WP5 sessions + search
  mountSessions();
  mountSearch();
  // WP6 profiles + settings
  mountSettings();
  mountProfiles();
  // WP7 usage
  mountUsage();
  // WP8 git
  // WP9 os
  mountOs();
  // WP10 updater
  // ---- end feature mounts ----
}
