// Profiles (WP6): the start screen choice, the profile picker, the avatar button and its popover, and new
// profiles. Handles the bus events profile:enter, profile:new and picker:show.

import type { CreatedProfile } from "../../bindings/CreatedProfile";
import { on } from "../../core/bus";
import { $ } from "../../core/dom";
import { animate, Spring } from "../../core/motion";
import { settings } from "../../core/settings";
import { type Screen, store } from "../../core/store";
import { setSubtitle } from "../../core/titlebar";
import { isMainWindow } from "../../core/window";
import { mountAvatarButton } from "./avatar-button";
import { newProfile } from "./newprofile";
import { mountPicker, type Picker } from "./picker";
import { closeProfilePopover } from "./popover";
import { enterProfile, startChoice } from "./startup";
import { T } from "./strings";
import "./profiles.css";

declare module "../../core/api" {
  interface Commands {
    /** Creates ~/.claude-<name> (letters, numbers, - or _) and emits `profiles-changed`. */
    create_profile: { args: { name: string }; result: CreatedProfile };
    /** Opens a discovered profile's folder in Explorer / Finder. */
    open_profile_folder: { args: { dir: string }; result: null };
  }
}

let picker: Picker | null = null;

export function showPicker(): void {
  closeProfilePopover();
  store.set({ screen: "picker" });
  requestAnimationFrame(() => picker?.focus());
}

/**
 * While the picker shows, the title bar says "Choose a profile". Other features keep writing their own
 * subtitle meanwhile (the sidebar does on every change); the latest one comes back when the picker goes.
 */
function holdSubtitle() {
  const sub = $("#tb-subtitle");
  // the nodes, not the text: the sidebar's subtitle has icons
  let saved: Node[] = [...sub.childNodes];
  let holding = false;
  const hold = () => {
    if (sub.textContent === T.pickerSubtitle) return;
    saved = [...sub.childNodes];
    setSubtitle(T.pickerSubtitle);
  };
  // registered after the sidebar's listeners, so this runs after they wrote theirs
  store.subscribe((s) => {
    if (s.screen === "picker") {
      holding = true;
      hold();
    } else if (holding) {
      holding = false;
      sub.replaceChildren(...saved);
    }
  });
  if (store.get().screen === "picker") {
    holding = true;
    hold();
  }
}

/** Screens cross-fade (opacity spring 0.3; reduced motion snaps). The shell has already swapped them. */
function crossfade() {
  const fade = new Spring(0.3, 1, 0.003, 1);
  const apply = (screen: Screen) => {
    document.documentElement.classList.toggle("prof-picker-open", screen === "picker");
    const el = $(screen === "picker" ? "#picker-root" : "#main");
    if (!document.documentElement.classList.contains("ready")) return; // the window fades in by itself
    fade.snap(0);
    el.style.opacity = "0";
    animate(
      fade,
      1,
      (v) => {
        el.style.opacity = String(Math.min(1, v));
      },
      () => {
        el.style.opacity = "";
      },
    );
  };
  store.select((s) => s.screen, apply, { immediate: true });
}

export function mount(): void {
  picker = mountPicker($("#picker-root"));
  mountAvatarButton($("#tb-profile-slot"));
  crossfade();
  holdSubtitle();

  on("profile:enter", ({ dir }) => enterProfile(dir));
  on("profile:new", () => void newProfile());
  on("picker:show", showPicker);

  const s = store.get();
  // another window (New window, moved tabs) never starts on the picker: the profile last used, else all
  const main = isMainWindow();
  const choice = startChoice(main ? settings() : { ...settings(), showPicker: false }, s.profiles, s.platform.os);
  if (choice.picker && main) showPicker();
  else enterProfile(choice.picker ? null : choice.dir);
}
