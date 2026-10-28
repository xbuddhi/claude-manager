// Public API of the source control feature. Other features may import this file only.

import { call } from "../../core/api";
import type { MenuItem } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { openUrlHttps } from "../os/api";
import { git } from "./backend";
import { planSwitch, showBranchMenu } from "./branch";
import { githubIcon } from "./icons";
import { errorText } from "./strings";

/** The https page of the repository `dir` is in (from its remote), or null: no repository or no remote. */
export async function repoWebUrl(dir: string): Promise<string | null> {
  const res = await call("git_web_url", { dir }, { quiet: true });
  return res.ok ? res.value : null;
}

/** The name the Open menu gives a repository page: "GitHub", "GitLab", "Bitbucket" or the host. */
export function webHostLabel(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const known: Record<string, string> = {
    "github.com": "GitHub",
    "gitlab.com": "GitLab",
    "bitbucket.org": "Bitbucket",
  };
  return known[host] ?? host;
}

/** A menu item opening the repository page `url`; `label` gets the host's name ("Open on" -> "Open on GitHub"). */
export function webMenuItem(url: string, label?: string): MenuItem {
  const host = webHostLabel(url);
  return {
    label: label ? `${label} ${host}` : host,
    icon: host === "GitHub" ? githubIcon() : "external",
    run: () => void openUrlHttps(url),
  };
}

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
