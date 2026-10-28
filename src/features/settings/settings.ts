// The Settings sheet (Cmd+, / Ctrl+,, the macOS menu "Settings...", the profile popover): start screen,
// notifications, usage ring, where new sessions open, terminal scrollback, Option as Meta (macOS), the
// claude path override, the log folder, and the version with "Check for updates". Every change saves at once.

import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import type { OpenIn } from "../../bindings/OpenIn";
import type { Settings } from "../../bindings/Settings";
import type { SidebarStyle } from "../../bindings/SidebarStyle";
import type { TerminalTheme } from "../../bindings/TerminalTheme";
import type { Theme } from "../../bindings/Theme";
import { call } from "../../core/api";
import { h } from "../../core/dom";
import { describeError, log } from "../../core/log";
import { animate, Spring } from "../../core/motion";
import { isMac, isWindows } from "../../core/platform";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { button } from "../../ui/button";
import { segmented } from "../../ui/segmented";
import { toggle } from "../../ui/toggle";
import { setNotifications } from "../profiles/api";
import { checkNow, type UpdateCheck } from "../updater/api";
import { colorPicker, skinPicker } from "./colors";
import "./settings.css";

export const SCROLLBACK_MIN = 1000;
export const SCROLLBACK_MAX = 50000;

/** The scrollback typed into the field, kept within 1000-50000; null when it is not a number. */
export function parseScrollback(text: string): number | null {
  const n = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, n));
}

/** The status line under the claude path. */
export function claudeStatus(found: string | null): string {
  return found ? `Claude Code: ${found} (found)` : "Claude Code: not found";
}

export function updateText(r: UpdateCheck): string {
  switch (r.kind) {
    case "disabled":
      return "Updates are not turned on in this build.";
    case "current":
      return "Claude Manager is up to date.";
    case "available":
      return `Version ${r.version} is available.`;
    case "failed":
      return `Could not check for updates: ${r.message}`;
  }
}

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    "div",
    { class: "set-row" },
    h(
      "div",
      { class: "set-text" },
      h("span", { class: "set-label" }, label),
      hint ? h("span", { class: "set-hint" }, hint) : null,
    ),
    control,
  );
}

/** A row with a colour picker under its label. */
function pickerRow(label: string, picker: HTMLElement, hint: string): HTMLElement {
  return h(
    "div",
    { class: "set-row set-row-colors" },
    h("div", { class: "set-text" }, h("span", { class: "set-label" }, label), h("span", { class: "set-hint" }, hint)),
    picker,
  );
}

function section(title: string, ...rows: Array<HTMLElement | null>): HTMLElement {
  return h("section", { class: "set-section" }, h("h3", { class: "set-section-title" }, title), ...rows);
}

let openSheet: { close(): void } | null = null;

export function isSettingsOpen(): boolean {
  return openSheet !== null;
}

export function closeSettings(): void {
  openSheet?.close();
}

export function openSettings(): void {
  if (openSheet) return;
  const s = settings();
  const restore = document.activeElement;
  const cleanups: Array<() => void> = [];

  // ---- general ----
  const showPicker = toggle({
    checked: s.showPicker,
    label: "Show the profile picker when the app starts",
    onChange: (on) => void updateSettings({ showPicker: on }),
  });
  const notify = toggle({
    checked: s.notify,
    label: "Finish notifications",
    onChange: (on) => void setNotifications(on),
  });
  const usage = toggle({
    checked: s.showUsage,
    label: "Show plan usage in the title bar",
    onChange: (on) => void updateSettings({ showUsage: on }),
  });
  const sidebarHidden = toggle({
    checked: s.sidebarHidden,
    label: "Hide the sidebar",
    onChange: (on) => void updateSettings({ sidebarHidden: on }),
  });
  const theme = segmented<Theme>({
    label: "Theme",
    items: [
      { id: "system", label: "System" },
      { id: "light", label: "Light" },
      { id: "dark", label: "Dark" },
    ],
    value: s.theme,
    onChange: (id) => void updateSettings({ theme: id }),
  });
  const terminalTheme = segmented<TerminalTheme>({
    label: "Terminal theme",
    items: [
      { id: "app", label: "Same as app" },
      { id: "light", label: "Light" },
      { id: "dark", label: "Dark" },
    ],
    value: s.terminalTheme,
    onChange: (id) => void updateSettings({ terminalTheme: id }),
  });
  const terminalColors = colorPicker(s.terminalColors, (id) => void updateSettings({ terminalColors: id }));
  cleanups.push(terminalColors.dispose);
  const appColors = skinPicker(s.appColors, (id) => void updateSettings({ appColors: id }));
  cleanups.push(appColors.dispose);
  const sidebarStyle = segmented<SidebarStyle>({
    label: "Sidebar style",
    items: [
      { id: "classic", label: "Classic" },
      { id: "docked", label: "Docked" },
    ],
    value: s.sidebarStyle,
    onChange: (id) => void updateSettings({ sidebarStyle: id }),
  });
  const openIn = segmented<OpenIn>({
    label: "New sessions open in",
    items: [
      { id: "external", label: "New window" },
      { id: "embed", label: "Inside app" },
    ],
    value: s.openIn,
    onChange: (id) => void updateSettings({ openIn: id }),
  });

  // ---- terminal ----
  const scrollback = h("input", {
    type: "number",
    class: "set-input set-number",
    min: String(SCROLLBACK_MIN),
    max: String(SCROLLBACK_MAX),
    step: "1000",
    value: String(s.scrollback),
    attrs: { "aria-label": "Scrollback lines" },
  });
  scrollback.addEventListener("change", () => {
    const n = parseScrollback(scrollback.value);
    if (n === null) {
      scrollback.value = String(settings().scrollback);
      return;
    }
    scrollback.value = String(n);
    if (n !== settings().scrollback) void updateSettings({ scrollback: n });
  });
  const optionMeta = isMac()
    ? toggle({
        checked: s.macOptionIsMeta,
        label: "Use Option as Meta key",
        onChange: (on) => void updateSettings({ macOptionIsMeta: on }),
      })
    : null;
  const windowGlass = isMac()
    ? toggle({
        checked: s.windowGlass,
        label: "Window glass",
        onChange: (on) => void updateSettings({ windowGlass: on }),
      })
    : null;

  const claudePath = h("input", {
    type: "text",
    class: "set-input set-path",
    value: s.claudePath ?? "",
    placeholder: "Found automatically",
    spellcheck: false,
    autocomplete: "off",
    attrs: { "aria-label": "Claude Code path" },
  });
  const status = h("div", { class: "set-status selectable" }, "Claude Code: checking...");
  const refreshStatus = async () => {
    const res = await call("env_status", undefined, { quiet: true });
    status.textContent = res.ok ? claudeStatus(res.value.claudePath) : claudeStatus(null);
    status.classList.toggle("missing", !res.ok || !res.value.claudePath);
  };
  const savePath = async (text: string) => {
    const value = text.trim() || null;
    if (value === (settings().claudePath ?? null)) return;
    if (!(await updateSettings({ claudePath: value }))) claudePath.value = settings().claudePath ?? "";
    void refreshStatus();
  };
  claudePath.addEventListener("change", () => void savePath(claudePath.value));
  const browse = button({
    label: "Browse...",
    onClick: async () => {
      try {
        const picked = await openFile({
          title: "Choose the claude program",
          multiple: false,
          directory: false,
          filters: isWindows() ? [{ name: "claude", extensions: ["exe", "cmd"] }] : undefined,
        });
        if (typeof picked !== "string") return;
        claudePath.value = picked;
        await savePath(picked);
      } catch (e) {
        log.error(`choosing the claude path: ${describeError(e)}`);
      }
    },
  });

  // ---- about ----
  const version = h("span", { class: "set-label" }, "Claude Manager");
  const updateResult = h("span", { class: "set-hint" });
  const checkBtn = button({
    label: "Check for updates",
    onClick: async () => {
      checkBtn.disabled = true;
      updateResult.textContent = "Checking...";
      try {
        updateResult.textContent = updateText(await checkNow());
      } catch (e) {
        updateResult.textContent = updateText({ kind: "failed", message: describeError(e) });
      } finally {
        checkBtn.disabled = false;
      }
    },
  });
  if (isTauri()) {
    getVersion()
      .then((v) => {
        version.textContent = `Claude Manager ${v}`;
      })
      .catch((e) => log.warn(`app version: ${describeError(e)}`));
  }

  const titleId = "set-title";
  const close = button({ icon: "close", kind: "plain", title: "Close", onClick: () => finish() });
  const done = button({ label: "Done", kind: "primary", onClick: () => finish() });
  const body = h(
    "div",
    { class: "set-body" },
    section(
      "Appearance",
      row("Theme", theme.el, "System follows your computer's light or dark mode."),
      pickerRow("Interface colours", appColors.el, "Each comes in light and dark, as the theme picks."),
      windowGlass
        ? row("Window glass", windowGlass.el, "The desktop shows softly through the title bar and sidebar.")
        : null,
      row("Terminal theme", terminalTheme.el, "Terminals can be dark with a light app, or the other way round."),
      pickerRow("Terminal colours", terminalColors.el, "Default follows the interface colours."),
    ),
    section(
      "General",
      row("Show the profile picker when the app starts", showPicker.el),
      row("Finish notifications", notify.el, "A notification when Claude finishes while you are elsewhere."),
      row("Show plan usage in the title bar", usage.el),
      row(
        "Sidebar style",
        sidebarStyle.el,
        "Classic: the sidebar is on Home only. Docked: it stays beside your terminals too.",
      ),
      row(
        "Hide the sidebar",
        sidebarHidden.el,
        "Point at the left edge to slide it in. Ctrl+S shows or hides it any time.",
      ),
      row("New sessions open in", openIn.el),
    ),
    section(
      "Terminal",
      row("Scrollback lines", scrollback, `${SCROLLBACK_MIN} to ${SCROLLBACK_MAX}. New terminals use it.`),
      optionMeta ? row("Use Option as Meta key", optionMeta.el, "Option+key sends Esc+key, as shells expect.") : null,
      h(
        "div",
        { class: "set-row set-row-path" },
        h(
          "div",
          { class: "set-text" },
          h("span", { class: "set-label" }, "Claude Code path"),
          h("span", { class: "set-hint" }, "Leave empty to find it automatically."),
        ),
        h("div", { class: "set-path-row" }, claudePath, browse),
        status,
      ),
    ),
    section(
      "Help",
      row("Logs", button({ label: "Open logs folder", onClick: () => void call("open_log_dir") })),
      h("div", { class: "set-row" }, h("div", { class: "set-text" }, version, updateResult), checkBtn),
    ),
  );
  const sheet = h(
    "div",
    { class: "set-sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId } },
    h("header", { class: "set-head" }, h("h2", { class: "set-title", id: titleId }, "Settings"), close),
    body,
    h("footer", { class: "set-foot" }, done),
  );
  const backdrop = h("div", { class: "set-backdrop" }, sheet);
  (document.getElementById("overlay-root") ?? document.body).append(backdrop);

  // follow changes made elsewhere (the popover, another window) while the sheet is open
  cleanups.push(
    store.select(
      (st) => st.settings,
      (next: Settings) => {
        showPicker.set(next.showPicker);
        notify.set(next.notify);
        usage.set(next.showUsage);
        sidebarHidden.set(next.sidebarHidden);
        sidebarStyle.set(next.sidebarStyle);
        theme.set(next.theme);
        terminalTheme.set(next.terminalTheme);
        terminalColors.set(next.terminalColors);
        appColors.set(next.appColors);
        windowGlass?.set(next.windowGlass);
        openIn.set(next.openIn);
        optionMeta?.set(next.macOptionIsMeta);
        if (document.activeElement !== scrollback) scrollback.value = String(next.scrollback);
        if (document.activeElement !== claudePath) claudePath.value = next.claudePath ?? "";
      },
    ),
  );

  const spring = new Spring(0.22, 0.9, 0.003, 0.6);
  const draw = (v: number) => {
    backdrop.style.opacity = String(Math.min(1, v));
    sheet.style.transform = `translateY(${(1 - Math.min(1, v)) * 12}px)`;
  };
  let closed = false;
  function finish() {
    if (closed) return;
    closed = true;
    openSheet = null;
    // a path typed but not yet committed is saved like on blur
    if (claudePath.value.trim() !== (settings().claudePath ?? "")) void savePath(claudePath.value);
    for (const c of cleanups) c();
    sheet.removeAttribute("aria-modal");
    backdrop.style.pointerEvents = "none";
    animate(spring, 0, draw, () => backdrop.remove());
    if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
  }

  sheet.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish();
    } else if (e.key === "Tab") {
      const focusable = [...sheet.querySelectorAll<HTMLElement>("button:not(:disabled), input")].filter(
        (el) => el.tabIndex >= 0 && el.offsetParent !== null,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  });
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) {
      e.preventDefault();
      finish();
    }
  });

  openSheet = { close: finish };
  draw(spring.value);
  animate(spring, 1, draw);
  done.focus();
  void refreshStatus();
}
