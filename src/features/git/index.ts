// Source control (WP8): the "Source Control" view of the main card for the folder selected in the sidebar.

import { registerView } from "../../core/views";
import { gitView, startFollowing } from "./view";

export function mount(): void {
  registerView(gitView);
  startFollowing();
}
