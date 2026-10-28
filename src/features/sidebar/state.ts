// Sidebar-owned state (WP4). Collapsed groups and the FOLDERS section live in settings; these are session only.

import type { PathKind } from "../../bindings/PathKind";
import { defineState } from "../../core/store";

declare module "../../core/store" {
  interface AppState {
    /** Lower-cased names of groups whose whole folder list is shown ("Show N more" was clicked). */
    sidebarShowAll: readonly string[];
    /** Kinds of pinned and grouped folders the index does not list, by pathKey (from path_kinds). */
    sidebarKinds: Readonly<Record<string, PathKind>>;
    /** The hidden folders are listed at the end of FOLDERS ("Show N hidden" was clicked). */
    sidebarShowHidden: boolean;
  }
}

defineState({ sidebarShowAll: [], sidebarKinds: {}, sidebarShowHidden: false });
