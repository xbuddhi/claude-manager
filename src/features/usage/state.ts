// Usage-owned state (WP7). Plan numbers and local counts for the profiles in view.

import type { PlanReport } from "../../bindings/PlanReport";
import type { UsageReport } from "../../bindings/UsageReport";
import { defineState } from "../../core/store";

declare module "../../core/store" {
  interface AppState {
    /** Plan limits of the profiles in view (cached numbers first, then fresh ones). */
    usagePlans: PlanReport[];
    /** A plan refresh is running. */
    usagePlansBusy: boolean;
    /** Plans are missing or some failed for a reason other than "Not signed in". */
    usageNeedsRetry: boolean;
    /** Token counts from this computer's transcripts; null until the first count. */
    usageLocal: UsageReport | null;
    usageLocalBusy: boolean;
    /** The popover's "Other accounts" is open: the other signed-in profiles' plans are fetched too. Folded
     * at every start. */
    usageOthersOpen: boolean;
  }
}

defineState({
  usagePlans: [],
  usagePlansBusy: false,
  usageNeedsRetry: true,
  usageLocal: null,
  usageLocalBusy: false,
  usageOthersOpen: false,
});
