// Pure rules of the terminal feature (tested in logic.test.ts): tab titles, tab strip layout, quoting of
// dropped paths, output flow control and the ordered input queue.

import { leaf, truncate } from "../../core/format";

/** Separator between a tab's folder and profile, as in the Windows app. */
export const SUB_SEP = "  ·  ";

/** The muted text next to a tab's title: "<folder leaf>  ·  <profile name>". */
export function tabSub(dir: string, profileName: string): string {
  return `${leaf(dir)}${SUB_SEP}${profileName}`;
}

/** A tab's first title: "New session", the session label (40 characters), or "Fork of <label>". */
export function defaultTitle(resume: { fork?: boolean } | undefined, label: string | undefined): string {
  if (!resume) return "New session";
  const name = truncate((label ?? "").trim() || "Resumed session", 40);
  return resume.fork ? `Fork of ${name}` : name;
}

/** Titles a shell or claude sets that say nothing about the chat (the program's own name, a path to an exe). */
const GENERIC_TITLE =
  /^(claude( code)?|pwsh|powershell|windows powershell|administrator\b.*|.*[\\/][^\\/]+\.exe|-?zsh|-?bash|fish|login)$/i;

/** The chat name in a terminal title, without claude's spinner symbols; null for generic titles. */
export function chatName(raw: string): string | null {
  const t = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!t || GENERIC_TITLE.test(t)) return null;
  return t;
}

/** Dropped files as shell words followed by a space: double quotes on Windows, single quotes on macOS. */
export function quotePaths(paths: readonly string[], os: string): string {
  const quoted = paths.map((p) =>
    // Windows paths cannot contain a double quote; a POSIX path can contain anything but NUL
    os === "windows" ? `"${p}"` : `'${p.replace(/'/g, "'\\''")}'`,
  );
  return quoted.length ? `${quoted.join(" ")} ` : "";
}

export interface TabLayout {
  /** Indexes of the tabs that fit, in order; the active tab is always among them. */
  shown: number[];
  /** Width of each shown tab. */
  width: number;
  /** Some tabs did not fit: the "more" button is shown. */
  overflow: boolean;
}

export const TAB_MIN = 150;
export const TAB_MAX = 250;
export const TAB_FLOOR = 110;
export const TAB_GAP = 4;
export const MORE_W = 52;

/**
 * Which terminal tabs fit in `avail` pixels and how wide they are (the Windows app's tab strip): tabs share
 * the width between 150 and 250 px (never under 110), and the ones that do not fit go to the "more" menu.
 */
export function layoutTabs(n: number, active: number, avail: number): TabLayout {
  if (n <= 0) return { shown: [], width: 0, overflow: false };
  let fit = Math.max(1, Math.floor((avail + TAB_GAP) / (TAB_MIN + TAB_GAP)));
  const overflow = n > fit;
  if (overflow) fit = Math.max(1, Math.floor((avail - MORE_W + TAB_GAP) / (TAB_MIN + TAB_GAP)));
  const count = Math.min(n, fit);
  const shown = Array.from({ length: count }, (_, i) => i);
  if (active >= count) shown[count - 1] = active;
  const room = overflow ? avail - MORE_W : avail;
  const width = Math.max(TAB_FLOOR, Math.min(TAB_MAX, Math.floor((room + TAB_GAP) / count - TAB_GAP)));
  return { shown, width, overflow };
}

/** Output not yet parsed by xterm above which the terminal is paused, and below which it resumes. */
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 256 * 1024;

/** Counts output handed to xterm but not parsed yet, and says when to pause and resume the terminal. */
export class Watermark {
  pending = 0;
  paused = false;

  /** `n` bytes were handed to xterm; true = pause now. */
  add(n: number): boolean {
    this.pending += n;
    if (!this.paused && this.pending > HIGH_WATER) {
      this.paused = true;
      return true;
    }
    return false;
  }

  /** xterm parsed `n` bytes; true = resume now. */
  done(n: number): boolean {
    this.pending = Math.max(0, this.pending - n);
    if (this.paused && this.pending < LOW_WATER) {
      this.paused = false;
      return true;
    }
    return false;
  }
}

/** Input for a terminal: text (keys, pastes) or raw bytes (xterm's binary input). */
export type Input = string | number[];

/**
 * Sends input in order, one call at a time: everything typed while a call is in flight goes in the next
 * one (separate IPC calls could otherwise arrive out of order). Input queued before the terminal has
 * started waits until `start()`.
 */
export class InputQueue {
  private queue: Input[] = [];
  private busy = false;
  private started = false;

  constructor(private send: (data: Input) => Promise<boolean>) {}

  push(data: Input): void {
    if (typeof data === "string" ? data === "" : data.length === 0) return;
    const last = this.queue[this.queue.length - 1];
    if (typeof data === "string" && typeof last === "string") this.queue[this.queue.length - 1] = last + data;
    else if (Array.isArray(data) && Array.isArray(last)) last.push(...data);
    else this.queue.push(typeof data === "string" ? data : [...data]);
    void this.flush();
  }

  start(): void {
    this.started = true;
    void this.flush();
  }

  /** Drops what is queued (the terminal ended). */
  clear(): void {
    this.queue = [];
  }

  private async flush(): Promise<void> {
    if (this.busy || !this.started) return;
    this.busy = true;
    try {
      for (let next = this.queue.shift(); next !== undefined; next = this.queue.shift()) {
        if (!(await this.send(next))) {
          this.queue = [];
          break;
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

/** Calls `fn` at most once per `ms`, always with the latest value (trailing call included). */
export function throttle<T>(ms: number, fn: (value: T) => void): (value: T) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: T;
  return (value: T) => {
    latest = value;
    const wait = last + ms - Date.now();
    if (wait <= 0 && timer === undefined) {
      last = Date.now();
      fn(value);
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        last = Date.now();
        fn(latest);
      },
      Math.max(0, wait),
    );
  };
}

/** Calls `fn` once things have been quiet for `ms`, with the latest value. */
export function debounce<T>(ms: number, fn: (value: T) => void): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (value: T) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(value), ms);
  };
}

// ---- folder groups in the tab strip ----

/** Where a new tab of folder `key` goes: after the last tab of that folder, else at the end. */
export function insertIndex(keys: readonly string[], key: string): number {
  const i = keys.lastIndexOf(key);
  return i < 0 ? keys.length : i + 1;
}

/** Each folder's items together, the folders in the order they first appear; the order within one is kept. */
export function groupOrder<T>(items: readonly T[], key: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = groups.get(k);
    if (list) list.push(item);
    else groups.set(k, [item]);
  }
  return [...groups.values()].flat();
}

/** The colours folder groups take, in the order they are handed out (tokens.css; distinct in every skin). */
export const GROUP_COLORS = ["--lane-3", "--lane-4", "--lane-1", "--lane-2", "--term-blue", "--term-green"] as const;

/**
 * Colours (indexes into GROUP_COLORS) for the folder groups shown, in strip order. A folder keeps the one
 * it had in `prev`; a new one takes the first colour no other group has (they repeat only past six).
 */
export function assignColors(groups: readonly string[], prev: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const g of groups) {
    const had = prev.get(g);
    if (had !== undefined) out.set(g, had);
  }
  for (const g of groups) {
    if (out.has(g)) continue;
    const used = new Set(out.values());
    let c = 0;
    while (used.has(c) && c < GROUP_COLORS.length) c++;
    out.set(g, c < GROUP_COLORS.length ? c : out.size % GROUP_COLORS.length);
  }
  return out;
}
