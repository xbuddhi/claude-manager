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
    /** The list shows the archived sessions of the scope (session only; reset on another sidebar pick). */
    sessionsShowArchived: boolean;
  }
}

defineState({ sessionsScope: null, sessionsSelected: [], sessionsWanted: null, sessionsShowArchived: false });
