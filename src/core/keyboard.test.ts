import { describe, expect, it, vi } from "vitest";
import { registerCommand } from "./commands";
import { handleKeydown, matchChord, modalOpen, parseChord, registerShortcut } from "./keyboard";

const key = (k: string, code: string, mods: Partial<KeyboardEventInit> = {}) =>
  new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...mods });

describe("parseChord", () => {
  it("maps CmdOrCtrl per OS and drops Cmd bindings off macOS", () => {
    expect(parseChord("CmdOrCtrl+F", true)).toMatchObject({ key: "f", meta: true, ctrl: false });
    expect(parseChord("CmdOrCtrl+F", false)).toMatchObject({ key: "f", meta: false, ctrl: true });
    expect(parseChord("Cmd+R", false)).toBeNull();
    expect(parseChord("F5", false)).toMatchObject({ key: "F5" });
    expect(parseChord("Hyper+X", false)).toBeNull();
  });
});

describe("matchChord", () => {
  it("needs the exact modifiers", () => {
    const chord = parseChord("CmdOrCtrl+F", false);
    expect(chord && matchChord(chord, key("f", "KeyF", { ctrlKey: true }))).toBe(true);
    expect(chord && matchChord(chord, key("F", "KeyF", { ctrlKey: true, shiftKey: true }))).toBe(false);
  });

  it("falls back to the physical key when Shift or Option changed the character", () => {
    const next = parseChord("Cmd+Shift+]", true);
    expect(next && matchChord(next, key("}", "BracketRight", { metaKey: true, shiftKey: true }))).toBe(true);
    const opt = parseChord("Alt+F", true);
    expect(opt && matchChord(opt, key("ƒ", "KeyF", { altKey: true }))).toBe(true);
  });
});

describe("handleKeydown", () => {
  const run = vi.fn();
  registerCommand({ id: "test:find", run });
  registerShortcut({ id: "test:find", keys: "CmdOrCtrl+G" });

  /** Dispatches a key on `target` and reports whether the registry handled it. */
  function press(target: HTMLElement, event: KeyboardEvent, mac: boolean): boolean {
    let handled = false;
    const listener = (e: KeyboardEvent) => {
      handled = handleKeydown(e, mac);
    };
    target.addEventListener("keydown", listener);
    target.dispatchEvent(event);
    target.removeEventListener("keydown", listener);
    return handled;
  }

  const plain = document.createElement("div");
  const terminal = document.createElement("div");
  terminal.className = "xterm";
  const terminalInput = document.createElement("textarea");
  terminal.append(terminalInput);
  document.body.append(plain, terminal);

  it("runs the command for its keys", () => {
    run.mockClear();
    expect(press(plain, key("g", "KeyG", { ctrlKey: true }), false)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl keys to the terminal on Windows", () => {
    run.mockClear();
    expect(press(terminalInput, key("g", "KeyG", { ctrlKey: true }), false)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("takes Cmd keys from the terminal on macOS", () => {
    run.mockClear();
    expect(press(terminalInput, key("g", "KeyG", { metaKey: true }), true)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("waits while a modal dialog is open", () => {
    run.mockClear();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.append(modal);
    expect(press(plain, key("g", "KeyG", { ctrlKey: true }), false)).toBe(false);
    const reload = key("F5", "F5");
    press(plain, reload, false);
    expect(reload.defaultPrevented).toBe(true);
    expect(modalOpen()).toBe(true);
    modal.remove();
    expect(modalOpen()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops the webview reload keys outside terminals", () => {
    const reload = key("r", "KeyR", { ctrlKey: true });
    press(plain, reload, false);
    expect(reload.defaultPrevented).toBe(true);
    const inTerminal = key("r", "KeyR", { ctrlKey: true });
    press(terminalInput, inTerminal, false);
    expect(inTerminal.defaultPrevented).toBe(false);
  });
});
