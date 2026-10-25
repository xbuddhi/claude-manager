// Search (WP5): the title-bar search box. Mounts into #tb-search-slot.

import { $ } from "../../core/dom";
import { mountSearch } from "./search";

export function mount(): void {
  mountSearch($("#tb-search-slot"));
}
