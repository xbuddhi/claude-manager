// Sidebar (WP4): the "Workspace" card with the projects/groups tree, pins, drag and drop, the folder and
// project menus, and folders dropped on the window. See view.ts (tree), groups.ts (projects and pins),
// menus.ts (actions and menus), drag.ts (moving folders) and drop.ts (OS folder drop).

import "./state";
import { $ } from "../../core/dom";
import { initDrop } from "./drop";
import { mountView } from "./view";
import "./sidebar.css";

export function mount(): void {
  mountView($("#sidebar-slot"));
  void initDrop();
}
