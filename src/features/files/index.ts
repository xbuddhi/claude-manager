// Files: the folder selected in the sidebar as a file tree with a read-only preview and plain file
// operations, beside Sessions, Source Control and Memory.

import { registerView } from "../../core/views";
import { filesView, startFollowing } from "./view";

export function mount(): void {
  registerView(filesView);
  startFollowing();
}
