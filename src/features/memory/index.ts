// Memory: the CLAUDE.md files and auto memory Claude Code loads for the folder selected in the sidebar,
// under the profile in view, shown read-only beside Sessions and Source Control.

import { registerView } from "../../core/views";
import { memoryView, startFollowing } from "./view";

export function mount(): void {
  registerView(memoryView);
  startFollowing();
}
