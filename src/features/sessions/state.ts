// Sessions-owned state (WP5).

import { defineState } from "../../core/store";
import type { Scope } from "./model";

declare module "../../core/store" {
  interface AppState {
    /** What the sessions view lists for the sidebar selection; null when nothing is selected. */
    sessionsScope: Scope | null;
    /** Ids of the selected sessions, in row order. */
    sessionsSelected: string[];
    /** A session to select once the table lists it (set by selectSession, e.g. a search pick). */
    sessionsWanted: string | null;
  }
}

defineState({ sessionsScope: null, sessionsSelected: [], sessionsWanted: null });
