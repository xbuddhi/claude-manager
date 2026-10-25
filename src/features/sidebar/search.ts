// TEMPORARY search box in the title bar (#tb-search-slot), ported from the prototype's sidebar filter.
// WP5 replaces it with the search dropdown.

import { emit, on } from "../../core/bus";
import { h } from "../../core/dom";
import { icons } from "../../core/icons";
import { store } from "../../core/store";
import "./state";

export function mountSearch(slot: HTMLElement): void {
  const input = h("input", {
    type: "search",
    class: "sb-search-input",
    placeholder: "Search projects and sessions",
    spellcheck: false,
    autocomplete: "off",
    attrs: { "aria-label": "Search projects and sessions" },
  });
  const glyph = h("span", { class: "sb-search-icon" });
  glyph.innerHTML = icons.search;
  slot.append(h("div", { class: "sb-search" }, glyph, input));

  input.addEventListener("input", () => store.set({ searchQuery: input.value }));
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !input.value) return;
    e.preventDefault();
    input.value = "";
    store.set({ searchQuery: "" });
  });
  on("search:focus", () => {
    // the box sits over the workspace; bring it to the front first
    if (store.get().activeTerminal !== null) emit("terminal:show", { id: null });
    input.focus();
    input.select();
  });
}
