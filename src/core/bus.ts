// Typed app-wide events between features. A feature never imports another feature's internals; it emits
// or handles one of these instead. Features add their own events by declaration merging:
//
//   declare module "../../core/bus" { interface AppEvents { "git:changed": { repo: string } } }

import { log } from "./log";

export type LaunchMode = "embed" | "external";

/** Start claude in a folder: a new session, or a resumed/forked one. */
export interface LaunchRequest {
  dir: string;
  /** Profile folder; when absent the handler picks the start profile. */
  profile?: string;
  /** Where it opens; when absent, settings.openIn decides. */
  mode?: LaunchMode;
  resume?: { sessionId: string; fork?: boolean };
  /** Tab or window title, e.g. the session label. */
  label?: string;
}

export interface AppEvents {
  /** Handled by the terminals feature (WP2). */
  launch: LaunchRequest;
  /** Bring a terminal tab to the front; null shows the workspace (Home). Handled by terminals (WP2). */
  "terminal:show": { id: number | null };
  /** Resume a session, switching to it when it is already running. Handled by sessions actions (WP5). */
  "session:resume": { sessionId: string; mode?: LaunchMode; fork?: boolean };
  /** Rescan everything. Handled by the index data adapter (WP1) and core profiles. */
  "refresh:full": undefined;
  /** Select a sidebar row by key. Handled by the sidebar (WP4). */
  "sidebar:select": { key: string };
  /** Focus the search box. Handled by whoever owns search (WP5). */
  "search:focus": undefined;
  /** Enter a profile (null = all profiles). Handled by profiles (WP6). */
  "profile:enter": { dir: string | null };
  /** Handled by profiles (WP6). */
  "profile:new": undefined;
  /** Handled by profiles (WP6). */
  "picker:show": undefined;
}

type Args<E, K extends keyof E> = E[K] extends undefined ? [payload?: undefined] : [payload: E[K]];
type Handler<E, K extends keyof E> = (payload: E[K]) => void;

export interface Bus<E> {
  on<K extends keyof E>(name: K, handler: Handler<E, K>): () => void;
  once<K extends keyof E>(name: K, handler: Handler<E, K>): () => void;
  emit<K extends keyof E>(name: K, ...args: Args<E, K>): void;
  /** Whether anything handles `name` (e.g. to hide a menu item whose feature is not there yet). */
  handled(name: keyof E): boolean;
}

export function createBus<E>(): Bus<E> {
  const handlers = new Map<keyof E, Set<(payload: never) => void>>();
  const bus: Bus<E> = {
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        set = new Set();
        handlers.set(name, set);
      }
      set.add(handler as (payload: never) => void);
      return () => set.delete(handler as (payload: never) => void);
    },
    once(name, handler) {
      const off = bus.on(name, (payload) => {
        off();
        handler(payload);
      });
      return off;
    },
    emit(name, ...args) {
      const set = handlers.get(name);
      if (!set?.size) {
        log.debug(`bus: nothing handles "${String(name)}"`);
        return;
      }
      // one failing handler must not stop the others
      for (const h of [...set]) {
        try {
          (h as (payload: unknown) => void)(args[0]);
        } catch (e) {
          log.error(`bus: handler for "${String(name)}" failed: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
        }
      }
    },
    handled: (name) => (handlers.get(name)?.size ?? 0) > 0,
  };
  return bus;
}

export const bus = createBus<AppEvents>();
export const { on, once, emit } = bus;
