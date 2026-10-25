// Keeps store.index current: fetches on start and whenever the backend reports a new index generation
// (its file watcher sees transcripts change). F5 / "Refresh" reads every transcript again.

import { listen } from "../../core/api";
import { on } from "../../core/bus";
import { refreshIndex, rescanIndex } from "./api";

export function mount(): void {
  void refreshIndex();
  // fetch again once listening, so a change between the first fetch and the listener is not missed
  void listen("index-changed", () => void refreshIndex()).then(() => refreshIndex());
  on("refresh:full", () => void rescanIndex());
}
