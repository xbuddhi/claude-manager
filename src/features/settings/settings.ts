// The Settings sheet (Cmd+, / Ctrl+,, the macOS menu "Settings...", the profile popover), laid out like macOS
// System Settings: tabs in a sidebar (Appearance, General, Terminal, About), each with its rows in groups.
// Theme, interface style and colours, App icon (macOS), start screen, notifications, usage ring, the sidebar,
// where new sessions open, terminal theme and colours, scrollback, Option as Meta (macOS), the claude path
// override, the version with "Check for updates" and the log folder. Every change saves at once.

import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import type { InterfaceSize } from "../../bindings/InterfaceSize";
import type { OpenIn } from "../../bindings/OpenIn";
import type { Settings } from "../../bindings/Settings";
import type { SidebarStyle } from "../../bindings/SidebarStyle";
import type { TerminalTheme } from "../../bindings/TerminalTheme";
import type { Theme } from "../../bindings/Theme";
import type { UiStyle } from "../../bindings/UiStyle";
import { call } from "../../core/api";
import { h } from "../../core/dom";
import { type IconSpec, iconNode } from "../../core/icons";
import { describeError, log } from "../../core/log";
import { animate, Spring } from "../../core/motion";
import { isMac, isWindows } from "../../core/platform";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { liquidGlassAvailable } from "../../core/theme";
import { button } from "../../ui/button";
import { segmented } from "../../ui/segmented";
import { toggle } from "../../ui/toggle";
import { setNotifications } from "../profiles/api";
import { checkNow, type UpdateCheck } from "../updater/api";
import { appIconSrc, colorPicker, iconPicker, skinPicker } from "./colors";
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

/** One tab of the sheet: its rows in groups (rounded boxes, as in System Settings); null rows are left out. */
interface Page {
  id: string;
  title: string;
  icon: IconSpec;
  /** The colour of the tab's icon tile. */
  tint: string;
  /** Shown above the groups, outside a box (the About card). */
  lead?: HTMLElement;
  groups: Array<Array<HTMLElement | null>>;
}

/** The project's repository (About). */
const REPO_URL = "https://github.com/xbuddhi/claude-manager";

/**
 * The GitHub mark, GitHub's own logo: the path of Octicons "mark-github" as published on Wikimedia Commons
 * (File:Octicons-mark-github.svg, MIT licence), in its 16-unit grid. Filled with the text colour.
 */
function githubMark(): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg class="set-gh" viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"/></svg>`;
  return t.content.firstElementChild as Element;
}

/**
 * The tabs' icons, from Lucide (lucide-static 0.469.0, ISC licence, credited in THIRD_PARTY_NOTICES): drawn
 * on their 24 grid, scaled to 16 like the shared gear (core/icons.ts). Only Settings uses them.
 */
const LUCIDE = {
  palette: `<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`,
  "square-terminal": `<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>`,
  info: `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`,
} as const;

function lucide(name: keyof typeof LUCIDE): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><g transform="scale(0.6667)">${LUCIDE[name]}</g></svg>`;
  for (const shape of t.content.querySelectorAll("path, rect, circle")) {
    shape.setAttribute("vector-effect", "non-scaling-stroke");
  }
  return t.content.firstElementChild as Element;
}

/** The tab shown last, opened again next time (this run only). */
let lastTab = "appearance";

/**
 * The sheet's tabs, as macOS System Settings lays them out: a sidebar of tabs (an icon tile and a name), and
 * the chosen tab's title and groups beside it. Up/Down move between tabs.
 */
function settingsTabs(pages: Page[], titleId: string) {
  const title = h("h2", { class: "set-title", id: titleId });
  const body = h("div", { class: "set-body" });
  const nav = h(
    "nav",
    { class: "set-nav", attrs: { role: "tablist", "aria-orientation": "vertical", "aria-label": "Settings" } },
    h("div", { class: "set-nav-head" }, "Settings"),
  );
  const tabs = pages.map((p) => {
    const groups = p.groups.filter((g) => g.some(Boolean)).map((g) => h("div", { class: "set-group" }, ...g));
    const panel = h(
      "div",
      { class: "set-page", id: `set-page-${p.id}`, attrs: { role: "tabpanel", "aria-labelledby": titleId } },
      p.lead ?? null,
      ...groups,
    );
    const tab = h(
      "button",
      {
        type: "button",
        class: "set-tab",
        attrs: { role: "tab", "aria-controls": panel.id },
        onclick: () => show(p.id),
      },
      h("span", { class: "set-tab-ico", style: { background: p.tint } }, iconNode(p.icon)),
      h("span", { class: "set-tab-name" }, p.title),
    );
    return { page: p, panel, tab };
  });
  nav.append(...tabs.map((t) => t.tab));
  body.append(...tabs.map((t) => t.panel));

  function show(id: string) {
    lastTab = id;
    for (const t of tabs) {
      const on = t.page.id === id;
      t.panel.hidden = !on;
      t.tab.classList.toggle("on", on);
      t.tab.setAttribute("aria-selected", String(on));
      t.tab.tabIndex = on ? 0 : -1;
      if (on) title.textContent = t.page.title;
    }
    body.scrollTop = 0;
  }
  nav.addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.page.id === lastTab);
    const next = tabs[(i + step + tabs.length) % tabs.length];
    if (!next) return;
    show(next.page.id);
    next.tab.focus();
  });
  show(tabs.some((t) => t.page.id === lastTab) ? lastTab : (pages[0]?.id ?? ""));
  return {
    nav,
    title,
    body,
    focus: () => tabs.find((t) => t.page.id === lastTab)?.tab.focus(),
  };
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
  const interfaceSize = segmented<InterfaceSize>({
    label: "Interface size",
    items: [
      { id: "small", label: "Small" },
      { id: "default", label: "Default" },
      { id: "large", label: "Large" },
      { id: "larger", label: "Larger" },
    ],
    value: s.interfaceSize,
    onChange: (id) => void updateSettings({ interfaceSize: id }),
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
  // the Dock icon (macOS)
  const appIcon = isMac() ? iconPicker(s.appIcon, (id) => void updateSettings({ appIcon: id })) : null;
  if (appIcon) cleanups.push(appIcon.dispose);
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
  const groupTabs = toggle({
    checked: s.groupTabs,
    label: "Group tabs by folder",
    onChange: (on) => void updateSettings({ groupTabs: on }),
  });
  const optionMeta = isMac()
    ? toggle({
        checked: s.macOptionIsMeta,
        label: "Use Option as Meta key",
        onChange: (on) => void updateSettings({ macOptionIsMeta: on }),
      })
    : null;
  // only where WebKit has the system glass material (macOS 26+)
  const uiStyle = liquidGlassAvailable()
    ? segmented<UiStyle>({
        label: "Interface style",
        items: [
          { id: "skin", label: "Skin" },
          { id: "glass", label: "Liquid Glass" },
        ],
        value: s.uiStyle,
        onChange: (id) => void updateSettings({ uiStyle: id }),
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
  // the app's card: its icon (the one chosen for the Dock), name, what it is, version, and the repository
  const aboutIcon = h("img", { class: "set-about-icon", src: appIconSrc(s.appIcon), alt: "" });
  const aboutVersion = h("span", { class: "set-about-version" }, "Version");
  // a regular push button, like the others in Settings (glass in the Liquid Glass style), and the repository
  // under it in quiet text
  const repoButton = button({
    label: "View on GitHub",
    icon: githubMark(),
    onClick: () => void call("open_url_https", { url: REPO_URL }),
  });
  repoButton.classList.add("set-about-gh");
  const repo = h(
    "div",
    { class: "set-about-links" },
    repoButton,
    h("span", { class: "set-about-repo" }, REPO_URL.replace(/^https:\/\//, "")),
  );
  const aboutCard = h(
    "div",
    { class: "set-about" },
    aboutIcon,
    h("span", { class: "set-about-name" }, "Claude Manager"),
    h("span", { class: "set-about-desc" }, "Every Claude Code project, session and profile in one window."),
    aboutVersion,
    repo,
  );
  const version = h("span", { class: "set-label" }, "Software update");
  const updateResult = h("span", { class: "set-hint" }, "Checks for a newer release on GitHub.");
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
        aboutVersion.textContent = `Version ${v}`;
      })
      .catch((e) => log.warn(`app version: ${describeError(e)}`));
  }

  const titleId = "set-title";
  const close = button({ icon: "close", kind: "plain", title: "Close", onClick: () => finish() });
  const pages: Page[] = [
    {
      id: "appearance",
      title: "Appearance",
      icon: lucide("palette"),
      tint: "#7c6cf0",
      groups: [
        [
          row("Theme", theme.el, "System follows your computer's light or dark mode."),
          row(
            "Interface size",
            interfaceSize.el,
            "Scales text, icons and spacing everywhere, terminals included. Every window follows.",
          ),
          uiStyle
            ? row(
                "Interface style",
                uiStyle.el,
                "Liquid Glass: the sidebar, bars and menus use the system's glass. The layout stays the same.",
              )
            : null,
          windowGlass
            ? row("Window glass", windowGlass.el, "The desktop shows softly through the title bar and sidebar.")
            : null,
        ],
        [pickerRow("Interface colours", appColors.el, "Each comes in light and dark, as the theme picks.")],
        appIcon
          ? [
              pickerRow(
                "App icon",
                appIcon.el,
                "Used everywhere macOS shows the app: Dock, Finder, Spotlight and Launchpad.",
              ),
            ]
          : [],
      ],
    },
    {
      id: "general",
      title: "General",
      icon: "gear",
      tint: "#8e8e93",
      groups: [
        [
          row("Show the profile picker when the app starts", showPicker.el),
          row("Finish notifications", notify.el, "A notification when Claude finishes while you are elsewhere."),
          row("Show plan usage in the title bar", usage.el),
        ],
        [
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
        ],
      ],
    },
    {
      id: "terminal",
      title: "Terminal",
      icon: lucide("square-terminal"),
      tint: "#3a3a3c",
      groups: [
        [
          row("Terminal theme", terminalTheme.el, "Terminals can be dark with a light app, or the other way round."),
          pickerRow("Terminal colours", terminalColors.el, "Default follows the interface colours."),
        ],
        [
          row(
            "Group tabs by folder",
            groupTabs.el,
            "Tabs of one folder sit together behind a chip with the folder's name; a click on it folds them.",
          ),
          row("Scrollback lines", scrollback, `${SCROLLBACK_MIN} to ${SCROLLBACK_MAX}. New terminals use it.`),
          optionMeta
            ? row("Use Option as Meta key", optionMeta.el, "Option+key sends Esc+key, as shells expect.")
            : null,
        ],
        [
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
        ],
      ],
    },
    {
      id: "about",
      title: "About",
      icon: lucide("info"),
      tint: "#0a84ff",
      lead: aboutCard,
      groups: [
        [h("div", { class: "set-row" }, h("div", { class: "set-text" }, version, updateResult), checkBtn)],
        [row("Logs", button({ label: "Open logs folder", onClick: () => void call("open_log_dir") }))],
      ],
    },
  ];
  const tabs = settingsTabs(pages, titleId);
  const sheet = h(
    "div",
    { class: "set-sheet", attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": titleId } },
    tabs.nav,
    h("div", { class: "set-main" }, h("header", { class: "set-head" }, tabs.title, close), tabs.body),
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
        interfaceSize.set(next.interfaceSize);
        terminalTheme.set(next.terminalTheme);
        terminalColors.set(next.terminalColors);
        appColors.set(next.appColors);
        windowGlass?.set(next.windowGlass);
        uiStyle?.set(next.uiStyle);
        appIcon?.set(next.appIcon);
        const src = appIconSrc(next.appIcon);
        if (aboutIcon.getAttribute("src") !== src) aboutIcon.src = src;
        openIn.set(next.openIn);
        optionMeta?.set(next.macOptionIsMeta);
        groupTabs.set(next.groupTabs);
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
  tabs.focus();
  void refreshStatus();
}
