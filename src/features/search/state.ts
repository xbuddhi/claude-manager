// Search-owned state (WP5).

import { defineState } from "../../core/store";

declare module "../../core/store" {
  interface AppState {
    /** Text in the title-bar search box. */
    searchQuery: string;
  }
}

defineState({ searchQuery: "" });
