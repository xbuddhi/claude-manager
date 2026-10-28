// Public API of the source control feature. Other features may import this file only.

import { call } from "../../core/api";
import type { MenuItem } from "../../ui/menu";
import { toast } from "../../ui/toast";
import { openUrlHttps } from "../os/api";
import { git } from "./backend";
import { planSwitch, showBranchMenu } from "./branch";
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

/** The GitHub mark (filled, unlike the stroke icons). */
function githubIcon(): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" style="fill:currentColor;stroke:none"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
  return t.content.firstElementChild as Element;
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
