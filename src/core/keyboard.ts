// Shortcut registry. A shortcut names a command (core/commands.ts); native menu items send the same ids
// through the backend `menu` event, so a menu click and its key run the same code.
//
// Key syntax: modifiers joined by "+" then one key, e.g. "CmdOrCtrl+F", "F5", "Cmd+Shift+]", "Ctrl+Tab".
// CmdOrCtrl is Cmd on macOS and Ctrl elsewhere; a "Cmd+..." binding exists only on macOS.

import { listen } from "./api";
import { runCommand } from "./commands";
import { isMac } from "./platform";

export interface Shortcut {
  /** Command id to run. */
  id: string;
  /** One binding or several alternatives. */
  keys: string | string[];
  /** Extra condition, checked when the keys match. */
  when?: () => boolean;
  /**
   * Fire while a text field has focus. Default: only bindings with Cmd/Ctrl/Alt or a function key do,
   * so plain keys (Delete, Escape) keep their text-editing meaning.
   */
  inInput?: boolean;
  /**
   * Fire while a terminal has focus. Default: only Cmd bindings on macOS. Ctrl and function keys belong to
   * the program running in the terminal (Ctrl+F, Ctrl+R and F5 mean something to a shell).
   */
  inTerminal?: boolean;
}

export interface Chord {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const NAMED_KEYS: Record<string, string> = { Space: " ", Plus: "+", Esc: "Escape", Del: "Delete" };

/** Parses one binding for this OS; null when it does not apply here (a Cmd binding off macOS) or is malformed. */
export function parseChord(spec: string, mac: boolean): Chord | null {
  const parts = spec.split("+").map((p) => p.trim());
  const rawKey = parts.pop();
  if (!rawKey) return null;
  const chord: Chord = { key: "", ctrl: false, meta: false, alt: false, shift: false };
  for (const m of parts) {
    switch (m) {
      case "CmdOrCtrl":
        if (mac) chord.meta = true;
        else chord.ctrl = true;
        break;
      case "Cmd":
      case "Command":
      case "Meta":
        if (!mac) return null;
        chord.meta = true;
        break;
      case "Ctrl":
      case "Control":
        chord.ctrl = true;
        break;
      case "Alt":
      case "Option":
        chord.alt = true;
        break;
      case "Shift":
        chord.shift = true;
        break;
      default:
        return null;
    }
  }
  const named = NAMED_KEYS[rawKey] ?? rawKey;
  chord.key = named.length === 1 ? named.toLowerCase() : named;
  return chord;
}

const CODE_FOR: Record<string, string> = {
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "-": "Minus",
  "=": "Equal",
  "`": "Backquote",
  "\\": "Backslash",
};

function codeFor(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return CODE_FOR[key];
}

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export function matchChord(chord: Chord, e: KeyLike): boolean {
  if (e.ctrlKey !== chord.ctrl || e.metaKey !== chord.meta || e.altKey !== chord.alt || e.shiftKey !== chord.shift) {
    return false;
  }
  if (chord.key.length > 1) return e.key === chord.key;
  const typed = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (typed === chord.key) return true;
  // Option and Shift change e.key ("ƒ", "}") and so do non-Latin layouts; fall back to the physical key then
  const printableAscii = /^[\x20-\x7e]$/.test(e.key);
  return (!printableAscii || chord.shift || chord.alt) && e.code === codeFor(chord.key);
}

interface Entry {
  shortcut: Shortcut;
  specs: string[];
  /** The bindings parsed for one OS (parsed on first use; tests may ask for the other OS). */
  parsed?: { mac: boolean; chords: Chord[] };
}

const entries: Entry[] = [];

/** The entry's bindings that apply on this OS, parsed once. */
function chordsOf(entry: Entry, mac: boolean): Chord[] {
  if (entry.parsed?.mac !== mac) {
    const chords: Chord[] = [];
    for (const spec of entry.specs) {
      const chord = parseChord(spec, mac);
      if (chord) chords.push(chord);
    }
    entry.parsed = { mac, chords };
  }
  return entry.parsed.chords;
}

/** Registers a shortcut; later registrations win over earlier ones for the same keys. */
export function registerShortcut(shortcut: Shortcut): () => void {
  const entry: Entry = { shortcut, specs: Array.isArray(shortcut.keys) ? shortcut.keys : [shortcut.keys] };
  entries.unshift(entry);
  return () => {
    const i = entries.indexOf(entry);
    if (i >= 0) entries.splice(i, 1);
  };
}

/** The first binding that applies on this OS for a command id, for menu and tooltip labels. */
export function shortcutFor(id: string): string | undefined {
  const mac = isMac();
  for (const { shortcut, specs } of entries) {
    if (shortcut.id !== id) continue;
    const spec = specs.find((s) => parseChord(s, mac));
    if (spec) return spec;
  }
  return undefined;
}

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(".xterm");
}

function inTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
}

function allowed(shortcut: Shortcut, chord: Chord, target: EventTarget | null, mac: boolean): boolean {
  if (inTerminal(target)) return shortcut.inTerminal ?? (mac && chord.meta);
  if (inTextField(target))
    return shortcut.inInput ?? (chord.ctrl || chord.meta || chord.alt || /^F\d+$/.test(chord.key));
  return true;
}

/** Keys that make the webview reload or print the page. A reload would end every terminal. */
function isBrowserKey(e: KeyboardEvent, mac: boolean): boolean {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const k = e.key.toLowerCase();
  return (mod && (k === "r" || k === "p")) || e.key === "F5";
}

let lastRun = { id: "", at: 0 };

/** While a modal dialog or sheet is open, app shortcuts, menu commands and terminal focus wait (they would act behind it). */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** Finds and runs the shortcut for a key event. Exposed for tests; installKeyboard() wires it to the window. */
export function handleKeydown(e: KeyboardEvent, mac = isMac()): boolean {
  if (e.isComposing || e.defaultPrevented) return false;
  if (!modalOpen() && runShortcut(e, mac)) {
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  if (!inTerminal(e.target) && isBrowserKey(e, mac)) e.preventDefault();
  return false;
}

function runShortcut(e: KeyboardEvent, mac: boolean): boolean {
  for (const entry of entries) {
    const { shortcut } = entry;
    for (const chord of chordsOf(entry, mac)) {
      if (!matchChord(chord, e) || !allowed(shortcut, chord, e.target, mac)) continue;
      if (shortcut.when && !shortcut.when()) continue;
      if (!runCommand(shortcut.id)) continue;
      lastRun = { id: shortcut.id, at: performance.now() };
      return true;
    }
  }
  return false;
}

/**
 * Routes a native menu item to its command. On macOS a menu key equivalent the page did not handle comes
 * back as a menu event; skip it if the same command just ran from the keyboard.
 */
export function handleMenu(id: string): void {
  if (modalOpen() || (lastRun.id === id && performance.now() - lastRun.at < 300)) return;
  runCommand(id);
}

export async function installKeyboard(): Promise<void> {
  // capture phase: shortcuts are seen before xterm or a focused control consumes the key
  window.addEventListener("keydown", (e) => handleKeydown(e), { capture: true });
  await listen("menu", ({ id }) => handleMenu(id));
}
