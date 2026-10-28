// The profile picker (Chrome style, ClaudeManager.ps1 Show-Picker): one card per profile, "All profiles"
// and "Add profile", with live session counts and the "Show this screen when the app starts" switch.
// Arrow keys move between cards by their position on screen, so the grid can wrap any way.

import type { Profile } from "../../bindings/Profile";
import { emit } from "../../core/bus";
import { h, reconcile } from "../../core/dom";
import { scroller } from "../../core/motion";
import { isMac } from "../../core/platform";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { avatar } from "../../ui/avatar";
import { showMenu } from "../../ui/menu";
import { toggle } from "../../ui/toggle";
import { countFor } from "../index-data/api";
import { hideProfile, profileAvatar, profileEmail, profileLabel, renameProfile, showProfile } from "./api";
import { chooseCompanion } from "./chooser";
import { companionFor } from "./companions";
import { enterProfile } from "./startup";
import { sessionCount, T } from "./strings";

/** A card: a profile folder, "all" profiles, the "add" card, or a profile removed from the app (dimmed). */
type CardId = { kind: "profile"; dir: string } | { kind: "all" } | { kind: "add" } | { kind: "hidden"; dir: string };

const cardKey = (c: CardId) => (c.kind === "profile" ? `p:${c.dir}` : c.kind === "hidden" ? `h:${c.dir}` : c.kind);

/** The hidden profiles are listed (session only). */
let showingHidden = false;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The card an arrow key moves to from card `from`: Left/Right go to the previous/next card, Up/Down to the
 * card in the row above/below whose centre is nearest. Returns `from` when there is none.
 */
export function gridMove(boxes: readonly Box[], from: number, key: string): number {
  const cur = boxes[from];
  if (!cur) return from;
  if (key === "ArrowLeft") return Math.max(0, from - 1);
  if (key === "ArrowRight") return Math.min(boxes.length - 1, from + 1);
  if (key === "Home") return 0;
  if (key === "End") return boxes.length - 1;
  if (key !== "ArrowUp" && key !== "ArrowDown") return from;
  const down = key === "ArrowDown";
  const cx = cur.left + cur.width / 2;
  // the nearest row in that direction, then the card in it nearest horizontally
  let rowTop: number | null = null;
  for (const b of boxes) {
    const ahead = down ? b.top > cur.top + cur.height / 2 : b.top + b.height / 2 < cur.top;
    if (ahead && (rowTop === null || (down ? b.top < rowTop : b.top > rowTop))) rowTop = b.top;
  }
  if (rowTop === null) return from;
  let best = from;
  let bestDist = Number.POSITIVE_INFINITY;
  boxes.forEach((b, i) => {
    if (b.top !== rowTop) return;
    const d = Math.abs(b.left + b.width / 2 - cx);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}

function cardIds(profiles: readonly Profile[], hidden: readonly Profile[]): CardId[] {
  return [
    ...profiles.map((p): CardId => ({ kind: "profile", dir: p.dir })),
    { kind: "all" },
    { kind: "add" },
    ...(showingHidden ? hidden.map((p): CardId => ({ kind: "hidden", dir: p.dir })) : []),
  ];
}

function createCard(id: CardId): HTMLElement {
  const card = h("button", { type: "button", class: "prof-card" });
  card.addEventListener("click", (e) => {
    if (id.kind === "profile" && (e.target as Element).closest(".prof-card-edit")) {
      void renameProfile(id.dir);
      return;
    }
    if (id.kind === "hidden") void showProfile(id.dir);
    else if (id.kind === "add") emit("profile:new");
    else enterProfile(id.kind === "all" ? null : id.dir);
  });
  if (id.kind === "profile" || id.kind === "hidden") {
    const dir = id.dir;
    const hidden = id.kind === "hidden";
    card.addEventListener("keydown", (e) => {
      if (e.key === "F2") void renameProfile(dir);
      else if (!hidden && (e.key === "Delete" || (isMac() && e.metaKey && e.key === "Backspace")))
        void hideProfile(dir);
      else return;
      e.preventDefault();
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void showMenu(
        [
          { label: T.rename, icon: pencil(), run: () => void renameProfile(dir) },
          {
            label: T.chooseCompanion,
            icon: profileAvatar(dir, 16),
            run: () => chooseCompanion(dir, card.querySelector<HTMLElement>(".avatar") ?? card, profileLabel(dir)),
          },
          hidden
            ? { label: T.unhide, icon: "plus", run: () => void showProfile(dir) }
            : { label: T.hide, icon: "minus", run: () => void hideProfile(dir) },
        ],
        { at: { x: e.clientX, y: e.clientY }, label: profileLabel(dir) },
      );
    });
  }
  return card;
}

/** Rename (only the picker uses it). */
function pencil(): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.8l2.7 2.7-7.6 7.6H2.9v-2.7zM9 4.3l2.7 2.7"/></svg>`;
  return t.content.firstElementChild as Element;
}

/** Fills a card; called again whenever the profiles or the index change (only text that changed is touched). */
function updateCard(card: HTMLElement, id: CardId): void {
  const dir = id.kind === "profile" || id.kind === "hidden" ? id.dir : null;
  const add = id.kind === "add";
  const hidden = id.kind === "hidden";
  const name = add ? T.addProfile : profileLabel(dir);
  const mail = add ? T.addProfileSub : hidden ? T.hiddenCard : profileEmail(dir);
  const loaded = store.get().index.loaded !== "loading";
  const count = add || !loaded ? "" : sessionCount(countFor(dir));
  card.classList.toggle("prof-card-hidden", hidden);
  // the companion is in it, so choosing another one redraws the card
  const sig = `${name}\n${mail}\n${count}\n${dir === null ? "" : companionFor(dir).key}`;
  if (card.dataset.sig === sig) return;
  card.dataset.sig = sig;
  const pic = add ? avatar({ text: "+", color: "var(--ctrl)", size: 84 }) : profileAvatar(dir, 84, undefined, true);
  if (add) pic.classList.add("prof-avatar-all");
  card.replaceChildren(
    pic,
    h("span", { class: "prof-card-name" }, name),
    h("span", { class: "prof-card-mail" }, mail),
    h("span", { class: "prof-card-count" }, count),
  );
  // a pencil in the corner (a card is a button, so not a nested one: the card's click handler sees it)
  if (id.kind === "profile") {
    const edit = h("span", { class: "prof-card-edit", attrs: { "aria-hidden": "true" } }, pencil());
    edit.dataset.tip = T.renameTip;
    card.append(edit);
  }
  card.setAttribute("aria-label", [name, mail, count].filter(Boolean).join(", "));
}

export interface Picker {
  /** Puts the keyboard on the card of the profile in view (or the first card). */
  focus(): void;
}

export function mountPicker(root: HTMLElement): Picker {
  const cards = h("div", { class: "prof-cards", attrs: { role: "group", "aria-label": "Profiles" } });
  const sw = toggle({
    checked: settings().showPicker,
    label: T.showPicker,
    showLabel: true,
    onChange: (on) => void updateSettings({ showPicker: on }),
  });
  const inner = h(
    "div",
    { class: "prof-picker" },
    h("h1", { class: "prof-title" }, T.pickerTitle),
    h("p", { class: "prof-sub" }, T.pickerSub),
    cards,
    h("div", { class: "prof-toggle" }, sw.el),
  );
  root.append(inner);
  root.classList.add("prof-picker-root");
  scroller(root);

  const more = h("button", { type: "button", class: "prof-more" });
  more.addEventListener("click", () => {
    showingHidden = !showingHidden;
    render();
  });
  const render = () => {
    const s = store.get();
    if (!s.hiddenProfiles.length) showingHidden = false;
    reconcile(cards, cardIds(s.profiles, s.hiddenProfiles), cardKey, createCard, updateCard);
    more.hidden = !s.hiddenProfiles.length;
    more.textContent = showingHidden ? T.hideHidden : T.showHidden(s.hiddenProfiles.length);
  };
  cards.after(more);
  store.select((s) => [s.profiles, s.hiddenProfiles, s.index, s.settings.profileCompanions] as const, render, {
    equals: (a, b) => a.every((v, i) => v === b[i]),
    immediate: true,
  });
  store.select(
    (s) => s.settings.showPicker,
    (on) => sw.set(on),
  );

  cards.addEventListener("keydown", (e) => {
    const list = [...cards.children] as HTMLElement[];
    const from = list.indexOf(e.target as HTMLElement);
    if (from < 0) return;
    const boxes = list.map((c) => ({
      left: c.offsetLeft,
      top: c.offsetTop,
      width: c.offsetWidth,
      height: c.offsetHeight,
    }));
    const to = gridMove(boxes, from, e.key);
    if (to === from && !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    list[to]?.focus();
  });

  return {
    focus() {
      const s = store.get();
      const key = s.currentProfile !== null ? `p:${s.currentProfile}` : s.settings.lastProfile === "all" ? "all" : "";
      const list = [...cards.children] as HTMLElement[];
      (list.find((c) => c.dataset.key === key) ?? list[0])?.focus({ preventScroll: true });
    },
  };
}
