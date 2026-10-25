// Views of the main card ("Sessions", "Source Control"). A feature registers its view; the foundation
// renders the switch in the card head (a segmented control once there are two or more views, otherwise
// the view's title) and shows one view at a time, following store.view.

import { segmented } from "../ui/segmented";
import { $, h } from "./dom";
import { store, type ViewId } from "./store";

export interface ViewDef {
  id: ViewId;
  title: string;
  /** Lower comes first in the switch. */
  order?: number;
  /** Called once with the view's own container inside #card-body. */
  mount(body: HTMLElement): void;
  /** Called once with the view's own container in the card head, shown only while the view is. */
  headerActions?(el: HTMLElement): void;
  onShow?(): void;
  onHide?(): void;
}

interface Mounted {
  def: ViewDef;
  body: HTMLElement;
  actions: HTMLElement;
}

const views: Mounted[] = [];

export function registerView(def: ViewDef): void {
  const body = h("div", {
    class: "view",
    dataset: { view: def.id },
    attrs: { role: "region", "aria-label": def.title },
  });
  const actions = h("div", { class: "view-actions", dataset: { view: def.id } });
  body.hidden = actions.hidden = true;
  $("#card-body").append(body);
  $("#card-actions-slot").append(actions);
  views.push({ def, body, actions });
  views.sort((a, b) => (a.def.order ?? 0) - (b.def.order ?? 0));
  def.mount(body);
  def.headerActions?.(actions);
  renderSwitch();
  if (store.get().view === def.id || views.length === 1) show(def.id);
}

export function showView(id: ViewId): void {
  if (views.some((v) => v.def.id === id)) store.set({ view: id });
}

function show(id: ViewId) {
  for (const v of views) {
    const visible = v.def.id === id;
    if (visible === !v.body.hidden) continue;
    v.body.hidden = v.actions.hidden = !visible;
    if (visible) v.def.onShow?.();
    else v.def.onHide?.();
  }
  if (store.get().view !== id) store.set({ view: id });
}

let switcher: ReturnType<typeof segmented<ViewId>> | null = null;

function renderSwitch() {
  const slot = $("#card-switch");
  slot.replaceChildren();
  switcher = null;
  const first = views[0];
  if (!first) return;
  if (views.length === 1) {
    slot.append(h("span", { class: "card-title" }, first.def.title));
    return;
  }
  switcher = segmented<ViewId>({
    label: "View",
    items: views.map((v) => ({ id: v.def.id, label: v.def.title })),
    value: store.get().view,
    onChange: showView,
  });
  slot.append(switcher.el);
}

/** Follows store.view (set by showView, a shortcut, or another feature). */
export function initViews(): void {
  store.select(
    (s) => s.view,
    (id) => {
      show(id);
      switcher?.set(id);
    },
  );
}
