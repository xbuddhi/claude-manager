// A full-width notice at the top of the main area for problems that block the app's purpose
// (e.g. Claude Code is not installed). One banner per id; showing an id again replaces it.

import { h } from "../core/dom";
import { icons } from "../core/icons";
import "./banner.css";

export interface BannerOptions {
  id: string;
  kind?: "error" | "warning" | "info";
  /** First line bold, the rest normal. */
  text: string;
  actions?: Array<{ label: string; run: () => void }>;
  dismissible?: boolean;
}

export interface BannerHandle {
  close(): void;
}

export function showBanner(opts: BannerOptions): BannerHandle {
  closeBanner(opts.id);
  const kind = opts.kind ?? "error";
  const [title = "", ...rest] = opts.text.split("\n");
  const text = h("div", { class: "banner-text" }, h("strong", {}, title));
  if (rest.length) text.append(h("span", {}, rest.join("\n")));
  const el = h("div", {
    class: `banner banner-${kind}`,
    dataset: { banner: opts.id },
    attrs: { role: kind === "info" ? "status" : "alert" },
  });
  const glyph = h("span", { class: "banner-icon" });
  glyph.innerHTML = kind === "info" ? icons.info : icons.warning;
  el.append(glyph, text);
  for (const a of opts.actions ?? []) {
    el.append(h("button", { type: "button", class: "banner-action", textContent: a.label, onclick: a.run }));
  }
  if (opts.dismissible ?? true) {
    const x = h("button", {
      type: "button",
      class: "banner-close",
      onclick: () => el.remove(),
      attrs: { "aria-label": "Dismiss" },
    });
    x.innerHTML = icons.close;
    el.append(x);
  }
  const main = document.getElementById("main");
  if (main) main.prepend(el);
  else document.body.prepend(el);
  return { close: () => el.remove() };
}

export function closeBanner(id: string): void {
  document.querySelector(`[data-banner="${CSS.escape(id)}"]`)?.remove();
}
