// Sidebar-owned state. TEMPORARY: the search query moves to the search feature (WP5).

import { defineState } from "../../core/store";

declare module "../../core/store" {
  interface AppState {
    /** Text in the title-bar search box; filters projects and sessions. */
    searchQuery: string;
  }
}

defineState({ searchQuery: "" });
