// The app's one state object. Features read it with get(), change it with set(), and react with select().
//
// AppState holds the shared core fields below. A feature adds its own fields by declaration merging in its
// `features/<x>/state.ts` and gives them defaults with defineState():
//
//   declare module "../../core/store" { interface AppState { sessionFilter: string } }
//   defineState({ sessionFilter: "" });

import type { LiveSession } from "../bindings/LiveSession";
import type { PlatformInfo } from "../bindings/PlatformInfo";
import type { Profile } from "../bindings/Profile";
import type { Project } from "../bindings/Project";
import type { Settings } from "../bindings/Settings";

export type Listener<T> = (state: T, prev: T) => void;

export interface Store<T extends object> {
  get(): T;
  /** Shallow-merges the patch. Listeners run only when some top-level value actually changed (Object.is). */
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: Listener<T>): () => void;
  /** Calls `fn` when the selected value changes (and once right away with `immediate`). */
  select<S>(
    selector: (state: T) => S,
    fn: (value: S, prev: S) => void,
    opts?: { equals?: (a: S, b: S) => boolean; immediate?: boolean },
  ): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener<T>>();
  // a set() made by a listener is applied after the current round, so every listener sees changes in order
  const queue: Array<Partial<T> | ((state: T) => Partial<T>)> = [];
  let flushing = false;

  function apply(patch: Partial<T> | ((state: T) => Partial<T>)) {
    const p = typeof patch === "function" ? patch(state) : patch;
    let changed = false;
    for (const k in p) {
      if (!Object.is(state[k], p[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const prev = state;
    state = { ...state, ...p };
    for (const l of [...listeners]) l(state, prev);
  }

  return {
    get: () => state,
    set(patch) {
      queue.push(patch);
      if (flushing) return;
      flushing = true;
      try {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) apply(next);
      } finally {
        flushing = false;
        queue.length = 0;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    select(selector, fn, opts = {}) {
      const equals = opts.equals ?? Object.is;
      let current = selector(state);
      if (opts.immediate) fn(current, current);
      return this.subscribe((s) => {
        const next = selector(s);
        if (equals(next, current)) return;
        const prev = current;
        current = next;
        fn(next, prev);
      });
    },
  };
}

// ---------- core state ----------

export type Screen = "picker" | "main";
export type ViewId = "sessions" | "git" | "memory" | "files";
export type LoadState = "loading" | "ok" | "empty" | "error";

/** The session index as the frontend holds it. `gen` grows whenever `projects` is replaced. */
export interface IndexState {
  gen: number;
  projects: Project[];
  loaded: LoadState;
  error: string | null;
}

/** What is selected in the sidebar: one folder, or a group of folders. */
export interface SidebarSelection {
  kind: "folder" | "group";
  key: string;
  path?: string;
  name?: string;
  folders?: string[];
}

/** A terminal tab as other features see it. The terminals feature keeps its xterm objects to itself. */
export interface TermInfo {
  /** Tab id, stable for the tab's life. */
  id: number;
  /** Backend terminal id; null until the PTY has started (or when it failed to start). */
  ptyId: number | null;
  /** Process id of the terminal's child (claude); null until known or once it exited. */
  pid: number | null;
  title: string;
  sub: string;
  dir: string;
  profile: string;
  sessionId: string | null;
  exited: boolean;
}

/** Fields the foundation owns. */
export interface CoreState {
  platform: PlatformInfo;
  /** The profiles the app shows (named as the user named them; hidden ones left out). */
  profiles: Profile[];
  /** Profiles removed from the app (settings.hiddenProfiles), for the picker to bring back. */
  hiddenProfiles: Profile[];
  /** Profile folder in view; null = all profiles. */
  currentProfile: string | null;
  screen: Screen;
  settings: Settings;
  index: IndexState;
  /** Running claude sessions by session id (kept current by the live feature, WP3). */
  live: Record<string, LiveSession>;
  /** Highest live level per folder, keyed by pathKey() of the folder: 1 = open, 2 = working. */
  liveCwd: Record<string, 1 | 2>;
  sidebarSelection: SidebarSelection | null;
  terminals: TermInfo[];
  /** Tab id of the terminal in front; null = the workspace (Home). */
  activeTerminal: number | null;
  view: ViewId;
  windowFocused: boolean;
}

/** CoreState plus every field features add by declaration merging. */
export interface AppState extends CoreState {}

/** Same defaults as the backend's Settings::default(); replaced by get_settings during startup. */
export const DEFAULT_SETTINGS: Settings = {
  pinned: [],
  hidden: [],
  archived: [],
  profileNames: {},
  hiddenProfiles: [],
  profileCompanions: {},
  account: null,
  openIn: "external",
  showPicker: true,
  lastProfile: null,
  groups: [],
  ungroupedCollapsed: false,
  showUsage: true,
  notify: true,
  bgTerms: [],
  sidebarWidth: 340,
  sidebarHidden: false,
  sidebarStyle: "classic",
  theme: "system",
  terminalTheme: "app",
  terminalColors: "default",
  gitSplit: null,
  claudePath: null,
  macOptionIsMeta: true,
  scrollback: 2000,
  keepRunningOnClose: null,
};

function guessPlatform(): PlatformInfo {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const os = ua.includes("Mac") ? "macos" : ua.includes("Windows") ? "windows" : "linux";
  return { os, build: "", arch: "" };
}

const coreDefaults: CoreState = {
  platform: guessPlatform(),
  profiles: [],
  hiddenProfiles: [],
  currentProfile: null,
  screen: "main",
  settings: DEFAULT_SETTINGS,
  index: { gen: 0, projects: [], loaded: "loading", error: null },
  live: {},
  liveCwd: {},
  sidebarSelection: null,
  terminals: [],
  activeTerminal: null,
  view: "sessions",
  windowFocused: true,
};

// feature fields are added by defineState() when each feature module loads
export const store = createStore<AppState>(coreDefaults as AppState);

/** Gives a feature's own AppState fields their starting values (fields already set are left alone). */
export function defineState<K extends keyof AppState>(defaults: Pick<AppState, K>): void {
  const current = store.get() as Partial<AppState>;
  const missing: Partial<AppState> = {};
  for (const k of Object.keys(defaults) as K[]) if (!(k in current)) missing[k] = defaults[k];
  store.set(missing);
}
