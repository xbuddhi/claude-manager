// Named actions. Keyboard shortcuts, the native menu (its item ids) and in-app menus all run actions
// by id, so one action has one implementation however it is triggered.

import { describeError, log } from "./log";

export interface Command {
  /** Same id as the native menu item, e.g. "tab:close". */
  id: string;
  title?: string;
  run: () => void | Promise<void>;
  /** When false the command does nothing (and a menu may show it disabled). */
  enabled?: () => boolean;
}

const commands = new Map<string, Command>();

/** Registers a command; a later registration with the same id replaces it. Returns an unregister function. */
export function registerCommand(command: Command): () => void {
  commands.set(command.id, command);
  return () => {
    if (commands.get(command.id) === command) commands.delete(command.id);
  };
}

export function hasCommand(id: string): boolean {
  return commands.has(id);
}

export function isEnabled(id: string): boolean {
  const c = commands.get(id);
  return !!c && (c.enabled?.() ?? true);
}

/** Runs a command. Returns false when there is no such command or it is disabled. */
export function runCommand(id: string): boolean {
  const c = commands.get(id);
  if (!c) {
    log.debug(`command "${id}" is not registered`);
    return false;
  }
  if (c.enabled && !c.enabled()) return false;
  try {
    const result = c.run();
    if (result instanceof Promise) result.catch((e) => log.error(`command "${id}" failed: ${describeError(e)}`));
  } catch (e) {
    log.error(`command "${id}" failed: ${describeError(e)}`);
  }
  return true;
}
