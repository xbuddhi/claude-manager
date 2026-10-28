// Public API of the source control feature. Other features may import this file only.

import { toast } from "../../ui/toast";
import { git } from "./backend";
import { planSwitch, showBranchMenu } from "./branch";
import { errorText } from "./strings";

/**
 * The branch menu of `repo` (a repository root) outside Source control, e.g. on a terminal's bar: switch
 * (with the same checks as Source control) or create a branch; the outcome is a toast. `onDone` runs after
 * git did anything, to read the branch again.
 */
export async function showBranchSwitcher(anchor: HTMLElement, repo: string, onDone: () => void): Promise<void> {
  const run = async (steps: string[][], done: string) => {
    for (const args of steps) {
      const out = await git(repo, args);
      if (out.code !== 0) {
        toast(errorText(out.code, out.stdout, out.stderr), { kind: "error" });
        onDone();
        return;
      }
    }
    toast(done, { kind: "success" });
    onDone();
  };
  await showBranchMenu(anchor, repo, {
    switchTo: async (name) => {
      const steps = await planSwitch(repo, name);
      if (steps) await run(steps, `Switched to ${name}`);
    },
    create: (name) => void run([["switch", "-c", name]], `Created and switched to ${name}`),
    error: (text) => toast(text, { kind: "error" }),
  });
}
