// Updater (WP10): checks for a new release shortly after startup and once a day, and offers
// "Restart to update" in a banner. Settings asks for a check through api.ts.

import { startChecks, warnIfReadOnly } from "./updater";

export function mount(): void {
  void warnIfReadOnly();
  startChecks();
}
