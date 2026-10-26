// One xterm bound to one backend terminal, used by the main window's tabs and by pop-out windows.
// - Options per platform (fonts, Option as Meta, ConPTY build), theme from the colour tokens (live), reduced
//   motion, unicode 11 widths, fit; the WebGL renderer only while the terminal is in front.
// - Keys per "Terminal input": copy/paste modifiers, Shift+Enter, the macOS Cmd editing keys.
// - Links open (https only) with Ctrl/Cmd+click, from plain text (web links) and OSC 8.
// - Output is written as bytes with flow control; input goes through an ordered queue; resizes are debounced.

import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { PtyExit } from "../../bindings/PtyExit";
import { call } from "../../core/api";
import { reduceMotion } from "../../core/motion";
import { isMac, isWindows, windowsBuild } from "../../core/platform";
import { settings } from "../../core/settings";
import { store } from "../../core/store";
import { onThemeChange, termDark } from "../../core/theme";
import { type MenuItem, showMenu } from "../../ui/menu";
import { copyText, openUrlHttps } from "../os/api";
import { chatName, debounce, type Input, InputQueue, throttle, Watermark } from "./logic";
import type { PtyOutput } from "./pty";

/** The 16 ANSI colours, as ITheme keys; their tokens are `--term-<kebab-case key>`. */
const ANSI = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** ANSI colours from the tokens; a missing token leaves xterm's default. */
export function ansiColors(v: (name: string) => string): Partial<ITheme> {
  const out: Partial<ITheme> = {};
  for (const key of ANSI) {
    const value = v(`--term-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * xterm colours from the app's tokens (styles/tokens.css), in the terminal theme (core/theme.ts). The ANSI
 * palette follows it too: xterm's own is made for dark backgrounds (white and bright yellow text
 * would vanish on the light one).
 */
function theme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const accent = v("--accent", "#d97757");
  return {
    ...ansiColors((name) => v(name, "")),
    background: v("--term-bg", "#141416"),
    foreground: v("--term-fg", "#e6e6ea"),
    cursor: accent,
    cursorAccent: v("--term-bg", "#141416"),
    selectionBackground: termDark() ? `${accent}55` : `${accent}40`,
  };
}

function fontFamily(): string {
  return isWindows()
    ? '"Cascadia Mono", "Cascadia Code", Consolas, "Segoe UI Emoji", "Nirmala UI", monospace'
    : 'ui-monospace, "SF Mono", Menlo, "Apple Color Emoji", monospace';
}

function smoothScroll(): number {
  return isMac() || reduceMotion.matches ? 0 : 110;
}

/** Ctrl+click on Windows, Cmd+click on macOS; anything but https is ignored. */
function openLink(e: MouseEvent, uri: string) {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (mod && /^https:\/\//i.test(uri)) void openUrlHttps(uri);
}

const views = new Set<TermView>();
let watching = false;

/** Theme, motion and settings changes reach every open terminal. */
function watch() {
  if (watching) return;
  watching = true;
  onThemeChange(() => {
    for (const v of views) v.term.options.theme = theme();
  });
  reduceMotion.addEventListener("change", () => {
    for (const v of views) {
      v.term.options.smoothScrollDuration = smoothScroll();
      v.term.options.cursorBlink = !reduceMotion.matches && document.hasFocus();
    }
  });
  store.select(
    (s) => s.settings.macOptionIsMeta,
    (meta) => {
      for (const v of views) v.term.options.macOptionIsMeta = isMac() && meta;
    },
  );
  store.select(
    (s) => s.settings.scrollback,
    (lines) => {
      for (const v of views) v.term.options.scrollback = lines;
    },
  );
  // after sleep, a GPU reset or a long time hidden the canvas can be stale: repaint what is on screen
  const wake = () => {
    for (const v of views) v.wake();
  };
  window.addEventListener("focus", wake);
  const blink = () => {
    const on = !reduceMotion.matches && document.hasFocus();
    for (const v of views) v.term.options.cursorBlink = on;
  };
  window.addEventListener("focus", blink);
  window.addEventListener("blur", blink);
  window.addEventListener("pageshow", wake);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
}

/** How long after a lost WebGL context the renderer is tried again (the GPU is often back by then). */
const GL_RETRY_MS = 1500;

export interface TermViewOptions {
  /** The terminal named its chat (cleaned, at most 4 times a second). */
  onTitle?: (title: string) => void;
  /** Extra items at the end of the right-click menu (pop out, close, ...). */
  menuItems?: () => MenuItem[];
}

/** Increasing across every window (wall clock based), so the backend can drop a pause or resume that arrives
 * after a newer one. */
let flowCounter = 0;
function flowSeq(): number {
  flowCounter = (flowCounter + 1) % 1000;
  return Date.now() * 1000 + flowCounter;
}

export class TermView {
  readonly term: Terminal;
  readonly pane: HTMLElement;
  private fit = new FitAddon();
  private gl: WebglAddon | null = null;
  private glRetry: ReturnType<typeof setTimeout> | undefined;
  /** In front (main window: the active tab; a pop-out: always). */
  private active = false;
  private ptyId: number | null = null;
  private flow = new Watermark();
  private input = new InputQueue((data) => this.send(data));
  private disposed = false;
  private exitHandler: (exit: PtyExit) => void = () => {};
  /** ConPTY repaints on every resize: during a window drag only the last size is sent. */
  private resize = debounce(80, ({ cols, rows }: { cols: number; rows: number }) => {
    if (this.ptyId !== null && !this.disposed) {
      void call("pty_resize", { id: this.ptyId, cols, rows }, { quiet: true });
    }
  });

  constructor(
    parent: HTMLElement,
    private opts: TermViewOptions = {},
  ) {
    watch();
    this.pane = document.createElement("div");
    this.pane.className = "term-pane";
    this.pane.setAttribute("role", "tabpanel");
    parent.appendChild(this.pane);
    const mac = isMac();
    const reduce = reduceMotion.matches;
    this.term = new Terminal({
      allowProposedApi: true, // unicode11 widths
      fontFamily: fontFamily(),
      fontSize: mac ? 12 : 13,
      lineHeight: 1.15,
      cursorBlink: !reduce && document.hasFocus(),
      scrollback: settings().scrollback,
      smoothScrollDuration: smoothScroll(),
      macOptionIsMeta: mac && settings().macOptionIsMeta,
      macOptionClickForcesSelection: mac,
      theme: theme(),
      windowsPty: isWindows() ? { backend: "conpty", buildNumber: windowsBuild() } : undefined,
      linkHandler: { activate: openLink, allowNonHttpProtocols: false },
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon(openLink));
    views.add(this);
  }

  /** Opens xterm in its pane; call once the pane is visible, so it measures real cell sizes. */
  open(): void {
    this.term.open(this.pane);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.term.onData((data) => this.input.push(data));
    this.term.onBinary((data) => this.input.push(Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
    this.term.onResize((size) => this.resize(size));
    if (this.opts.onTitle) {
      const onTitle = this.opts.onTitle;
      const titled = throttle(250, (raw: string) => {
        const name = chatName(raw);
        if (name && !this.disposed) onTitle(name);
      });
      this.term.onTitleChange(titled);
    }
    this.pane.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Windows Terminal style: right-click copies the selection, or pastes when nothing is selected;
      // Shift+right-click (and every right-click on macOS) opens the menu
      if (!isMac() && !e.shiftKey) {
        if (this.term.hasSelection()) this.copy();
        else void this.pasteClipboard();
        return;
      }
      void showMenu(this.menu(), { at: { x: e.clientX, y: e.clientY }, label: "Terminal" });
    });
    this.fitNow();
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  get id(): number | null {
    return this.ptyId;
  }

  /** A new output channel for this view; `onExit` runs once, after the last output. */
  channel(onExit: (exit: PtyExit) => void): PtyOutput {
    this.exitHandler = onExit;
    const onOutput = new Channel<ArrayBuffer | PtyExit>();
    onOutput.onmessage = (msg) => {
      if (msg instanceof ArrayBuffer) {
        this.write(new Uint8Array(msg));
        return;
      }
      if (this.disposed) return;
      this.input.clear();
      this.exitHandler(msg);
    };
    return { onOutput };
  }

  /** The backend terminal is up: input typed meanwhile is sent now. */
  bind(ptyId: number): void {
    this.ptyId = ptyId;
    this.input.start();
    // xterm may have been resized while the terminal was starting; a hidden one is sized when shown
    if (this.pane.offsetParent !== null) void call("pty_resize", { id: ptyId, ...this.size }, { quiet: true });
  }

  private write(bytes: Uint8Array) {
    if (this.disposed) return;
    const n = bytes.length;
    if (this.flow.add(n) && this.ptyId !== null) {
      void call("pty_pause", { id: this.ptyId, seq: flowSeq() }, { quiet: true });
    }
    this.term.write(bytes, () => {
      if (this.flow.done(n) && this.ptyId !== null && !this.disposed) {
        void call("pty_resume_output", { id: this.ptyId, seq: flowSeq() }, { quiet: true });
      }
    });
  }

  private async send(data: Input): Promise<boolean> {
    if (this.ptyId === null || this.disposed) return false;
    return (await call("pty_write", { id: this.ptyId, data }, { quiet: true })).ok;
  }

  /** Writes a line of the app's own (not the program's) into the terminal. */
  note(text: string, color: "muted" | "error" = "muted"): void {
    if (this.disposed) return;
    const sgr = color === "error" ? "31" : "90";
    this.term.write(`\r\n\x1b[${sgr}m${text.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n`);
  }

  /** Pastes text the way a terminal does (bracketed when the program asked for it). */
  paste(text: string): void {
    if (text) this.term.paste(text);
  }

  focus(): void {
    this.term.focus();
  }

  fitNow(): void {
    if (this.disposed || this.pane.hidden || !this.pane.isConnected) return;
    try {
      this.fit.fit();
    } catch {
      // not measurable yet (hidden or zero-sized); the next resize fits it
    }
  }

  /** In front: fit, focus and the WebGL renderer; behind: back to the DOM renderer (one GL context in use). */
  setActive(active: boolean): void {
    if (this.disposed) return;
    this.active = active;
    if (!active) {
      clearTimeout(this.glRetry);
      this.gl?.dispose();
      this.gl = null;
      return;
    }
    this.fitNow();
    // the PTY may still have the size of another window (pop-out, before a reload)
    this.resize(this.size);
    this.startGl();
    this.focus();
  }

  /** The app woke (focus, visible again, after sleep): repaint, and bring back a lost WebGL renderer. */
  wake(): void {
    if (this.disposed || !this.active) return;
    this.startGl();
    this.term.refresh(0, this.term.rows - 1);
  }

  private startGl() {
    if (this.gl || this.disposed || !this.active) return;
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => {
        // xterm falls back to its DOM renderer, which paints nothing until told to: repaint now, and try
        // the GPU again shortly (after sleep it is usually back within a second)
        gl.dispose();
        if (this.gl === gl) this.gl = null;
        if (this.disposed) return;
        this.term.refresh(0, this.term.rows - 1);
        clearTimeout(this.glRetry);
        this.glRetry = setTimeout(() => this.wake(), GL_RETRY_MS);
      });
      this.term.loadAddon(gl);
      this.gl = gl;
      // the WebGL renderer measures cells to whole device pixels: fit again with its size
      this.fitNow();
      this.resize(this.size);
    } catch {
      // no WebGL: xterm keeps its DOM renderer
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    views.delete(this);
    this.input.clear();
    clearTimeout(this.glRetry);
    this.gl?.dispose();
    this.term.dispose();
    this.pane.remove();
  }

  private menu(): MenuItem[] {
    const sel = this.term.hasSelection();
    const items: MenuItem[] = [
      { label: "Copy", icon: "copy", shortcut: isMac() ? "Cmd+C" : "Ctrl+C", disabled: !sel, run: () => this.copy() },
      { label: "Paste", shortcut: isMac() ? "Cmd+V" : "Ctrl+V", run: () => void this.pasteClipboard() },
      { label: "Select All", run: () => this.term.selectAll() },
      { label: "Clear", run: () => this.term.clear() },
    ];
    const extra = this.opts.menuItems?.() ?? [];
    return extra.length ? [...items, { kind: "separator" }, ...extra] : items;
  }

  private copy(): void {
    const text = this.term.getSelection();
    if (text) void copyText(text);
    this.term.clearSelection();
  }

  private async pasteClipboard(): Promise<void> {
    const res = await call("pty_clipboard_text", undefined, { quiet: true });
    if (res.ok) this.paste(res.value);
    this.focus();
  }

  /** Keys per "Terminal input on macOS and Windows". false = xterm ignores the key. */
  private onKey(e: KeyboardEvent): boolean {
    const mac = isMac();
    const key = e.key.toLowerCase();
    // Shift+Enter: a newline in claude's prompt instead of sending it
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.type === "keydown") this.input.push("\x1b\r");
      return false;
    }
    if (e.type !== "keydown") return true;
    // copy/paste: Cmd on macOS (Ctrl+C and Ctrl+V always reach the program there), Ctrl on Windows
    const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (mod && !e.altKey && !e.shiftKey) {
      if (key === "c") {
        // without a selection Ctrl+C interrupts on Windows, as in any terminal
        if (!this.term.hasSelection()) return !mac;
        e.preventDefault();
        this.copy();
        return false;
      }
      // the browser's paste event reaches xterm, which pastes it
      if (key === "v") return false;
    }
    if (mac && e.metaKey && !e.ctrlKey && !e.altKey) {
      const send = (s: string) => {
        e.preventDefault();
        this.input.push(s);
        return false;
      };
      switch (e.key) {
        case "ArrowLeft":
          return send("\x01"); // start of line
        case "ArrowRight":
          return send("\x05"); // end of line
        case "Backspace":
          return send("\x15"); // delete to start of line
      }
      if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        this.term.clear();
        return false;
      }
      if (key === "a" && !e.shiftKey) {
        e.preventDefault();
        this.term.selectAll();
        return false;
      }
      // other Cmd keys belong to the app and the menu (Cmd+W, Cmd+T, ...), never to the program
      return false;
    }
    return true;
  }
}
