// The commit card shown when the pointer rests on a history row (like VS Code's): author, how long ago and
// the date, the whole message, the files / insertions / deletions, and the short hash (copy) and the
// commit's page on GitHub. The pointer can move onto it (to copy or open); it goes away when the pointer
// leaves both, on scroll, a press elsewhere, Esc or when the window loses focus.

import { h } from "../../core/dom";
import { iconNode } from "../../core/icons";
import { toast } from "../../ui/toast";
import { copyText, openUrlHttps } from "../os/api";
import { repoWebUrl, webHostLabel } from "./api";
import { git } from "./backend";
import { githubIcon, personIcon } from "./icons";
import {
  bodyParagraphs,
  type Commit,
  type CommitStats,
  commitDetailArgs,
  commitUrl,
  fullDate,
  longAge,
  parseShortstat,
} from "./strings";

/** Rest on a row this long before the card opens; moving to another row while it is open is instant. */
const OPEN_MS = 450;
/** Time to move from the row onto the card. */
const CLOSE_MS = 180;
const GAP = 6;
const MARGIN = 8;

interface Detail {
  body: string[];
  stats: CommitStats | null;
}

export interface CommitCard {
  /** Shows the card for `commit` beside `row` (after the delay, unless one is open). */
  hover(row: HTMLElement, commit: Commit): void;
  /** The pointer left the row. */
  leave(): void;
  hide(): void;
}

export function createCommitCard(repo: () => string | null): CommitCard {
  const el = h("div", { class: "git-card", attrs: { role: "tooltip" } });
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let shown: string | null = null;
  let seq = 0;
  const details = new Map<string, Detail>();
  const webs = new Map<string, Promise<string | null>>();

  const webOf = (r: string) => {
    let p = webs.get(r);
    if (!p) {
      p = repoWebUrl(r);
      webs.set(r, p);
    }
    return p;
  };

  async function detailOf(r: string, hash: string): Promise<Detail | null> {
    const known = details.get(hash);
    if (known) return known;
    const out = await git(r, commitDetailArgs(hash));
    if (out.code !== 0) return null;
    const [message = "", stat = ""] = out.stdout.split("\x1e");
    // %B is the subject, a blank line, then the body
    const body = message.replace(/^[^\n]*\n?/, "");
    const d = { body: bodyParagraphs(body), stats: parseShortstat(stat) };
    details.set(hash, d);
    return d;
  }

  function hide() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    shown = null;
    seq++;
    el.remove();
  }

  function place(row: HTMLElement) {
    const list = row.closest(".list") ?? row;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    // beside the history column, else over it
    let x = lr.right + GAP;
    if (x + w > window.innerWidth - MARGIN) x = Math.max(MARGIN, window.innerWidth - MARGIN - w);
    const y = Math.max(MARGIN, Math.min(rr.top, window.innerHeight - MARGIN - hgt));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  function render(c: Commit, d: Detail | null, web: string | null) {
    const head = h(
      "div",
      { class: "git-card-head" },
      personIcon(),
      h("span", { class: "git-card-author" }, c.author),
      iconNode("history"),
      h("span", {}, `${longAge(c.at)} (${fullDate(c.at)})`),
    );
    const parts: HTMLElement[] = [head, h("div", { class: "git-card-subject" }, c.subject)];
    for (const p of d?.body ?? []) parts.push(h("p", { class: "git-card-body" }, p));
    if (d?.stats) {
      const s = d.stats;
      parts.push(
        h(
          "div",
          { class: "git-card-stats" },
          `${s.files} file${s.files === 1 ? "" : "s"} changed`,
          s.insertions ? ", " : "",
          s.insertions
            ? h("span", { class: "git-card-ins" }, `${s.insertions} insertion${s.insertions === 1 ? "" : "s"}(+)`)
            : "",
          s.deletions ? ", " : "",
          s.deletions
            ? h("span", { class: "git-card-del" }, `${s.deletions} deletion${s.deletions === 1 ? "" : "s"}(-)`)
            : "",
        ),
      );
    }
    const copy = h("button", { type: "button", class: "git-card-link", attrs: { "aria-label": "Copy commit hash" } });
    copy.append(iconNode("commit"), h("span", {}, c.hash.slice(0, 7)), iconNode("copy"));
    copy.addEventListener("click", async () => {
      if (await copyText(c.hash)) toast("Commit hash copied");
    });
    const foot = h("div", { class: "git-card-foot" }, copy);
    if (web) {
      const open = h("button", { type: "button", class: "git-card-link" });
      open.append(githubIconFor(web), h("span", {}, `Open on ${webHostLabel(web)}`));
      open.addEventListener("click", () => {
        void openUrlHttps(commitUrl(web, c.hash));
        hide();
      });
      foot.append(h("span", { class: "git-card-sep" }, "|"), open);
    }
    parts.push(foot);
    el.replaceChildren(...parts);
  }

  const githubIconFor = (web: string) => (webHostLabel(web) === "GitHub" ? githubIcon() : iconNode("external"));

  async function open(row: HTMLElement, c: Commit) {
    const r = repo();
    if (!r) return;
    const mine = ++seq;
    const [d, web] = await Promise.all([detailOf(r, c.hash), webOf(r)]);
    if (mine !== seq || !row.isConnected) return;
    shown = c.hash;
    render(c, d, web);
    (document.getElementById("overlay-root") ?? document.body).append(el);
    place(row);
  }

  el.addEventListener("pointerenter", () => clearTimeout(closeTimer));
  el.addEventListener("pointerleave", () => {
    closeTimer = setTimeout(hide, CLOSE_MS);
  });
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (shown && !(e.target instanceof Node && el.contains(e.target))) hide();
    },
    true,
  );
  window.addEventListener("keydown", (e) => {
    if (shown && e.key === "Escape") hide();
  });
  window.addEventListener("blur", hide);

  return {
    hover(row, c) {
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
      if (shown === c.hash) return;
      if (shown) void open(row, c);
      else openTimer = setTimeout(() => void open(row, c), OPEN_MS);
    },
    leave() {
      clearTimeout(openTimer);
      // a card still loading for this row must not open after the pointer left
      if (!shown) seq++;
      else closeTimer = setTimeout(hide, CLOSE_MS);
    },
    hide,
  };
}
