import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
const message = vi.fn(async () => {});
vi.mock("../../ui/dialog", () => ({ message: (...a: unknown[]) => message(...(a as [])) }));
const toast = vi.fn();
vi.mock("../../ui/toast", () => ({ toast: (...a: unknown[]) => toast(...a) }));
vi.mock("../index-data/api", () => ({ refreshIndex: vi.fn(async () => {}) }));

import type { LaunchRequest } from "../../core/bus";
import { bus } from "../../core/bus";
import { store } from "../../core/store";
import {
  explorerMenuInstall,
  explorerMenuState,
  folderLabel,
  openInCode,
  revealLabel,
  terminalHere,
  terminalHereLabel,
  trashName,
} from "./api";
import { handleOpenRequest, installOpenRequests } from "./wiring";

const initial = store.get();
const setOs = (os: string) => store.set({ platform: { ...store.get().platform, os } });

beforeEach(() => {
  invoke.mockReset();
  message.mockClear();
  toast.mockClear();
});
afterEach(() => store.set(initial));

describe("labels", () => {
  it("follow the platform", () => {
    setOs("windows");
    expect([revealLabel(), folderLabel(), terminalHereLabel(), trashName()]).toEqual([
      "Show in Explorer",
      "Open in Explorer",
      "Open PowerShell here",
      "Recycle Bin",
    ]);
    setOs("macos");
    expect([revealLabel(), folderLabel(), terminalHereLabel(), trashName()]).toEqual([
      "Reveal in Finder",
      "Show in Finder",
      "Open Terminal here",
      "Trash",
    ]);
  });
});

describe("openInCode", () => {
  it("passes every path in one call", async () => {
    invoke.mockResolvedValue(null);
    expect(await openInCode(["C:\\a", "C:\\b"])).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_in_code", { paths: ["C:\\a", "C:\\b"] });
  });

  it("shows a dialog when VS Code is missing", async () => {
    invoke.mockRejectedValue({ code: "not_found", message: "VS Code was not found." });
    expect(await openInCode(["C:\\a"])).toBe(false);
    expect(message).toHaveBeenCalledWith("VS Code was not found.");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("terminalHere", () => {
  it("asks the terminals feature for a plain shell window", async () => {
    const seen: LaunchRequest[] = [];
    const off = bus.on("launch", (r) => seen.push(r));
    expect(await terminalHere("C:\\proj")).toBe(true);
    off();
    expect(seen).toEqual([{ dir: "C:\\proj", mode: "external", shellOnly: true }]);
  });

  it("says so when nothing can launch", async () => {
    expect(await terminalHere("C:\\proj")).toBe(false);
    expect(toast).toHaveBeenCalled();
  });
});

describe("Explorer menu", () => {
  it("does not exist on macOS", async () => {
    setOs("macos");
    expect(await explorerMenuState()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports its state on Windows", async () => {
    setOs("windows");
    invoke.mockResolvedValue(true);
    expect(await explorerMenuState()).toBe(true);
    expect(invoke).toHaveBeenCalledWith("explorer_menu_state", {});
  });

  it("confirms an install with the Windows app's message", async () => {
    invoke.mockResolvedValue(null);
    expect(await explorerMenuInstall()).toBe(true);
    expect(message.mock.calls[0]).toEqual([
      "Explorer menu added\nRight-click any folder and pick 'Open Claude Code here', with one entry per profile. On Windows 11 it is under 'Show more options'.",
    ]);
  });
});

describe("open requests", () => {
  const launches: LaunchRequest[] = [];
  let off = () => {};
  beforeEach(() => {
    launches.length = 0;
    off = bus.on("launch", (r) => launches.push(r));
  });
  afterEach(() => off());

  it("pin the folder once and start a tab with the profile", async () => {
    setOs("windows");
    store.set({ settings: { ...store.get().settings, pinned: ["C:\\Work\\App"] } });
    invoke.mockImplementation(async (cmd: string, args: { patch: { pinned: string[] } }) =>
      cmd === "update_settings" ? { ...store.get().settings, ...args.patch } : null,
    );

    await handleOpenRequest({ dir: "c:\\work\\app\\", profile: "C:\\Users\\me\\.claude-work" });
    expect(invoke).not.toHaveBeenCalled();
    await handleOpenRequest({ dir: "D:\\other", profile: null });
    expect(invoke).toHaveBeenCalledWith("update_settings", { patch: { pinned: ["C:\\Work\\App", "D:\\other"] } });

    expect(launches).toEqual([
      { dir: "c:\\work\\app\\", profile: "C:\\Users\\me\\.claude-work", mode: "embed" },
      { dir: "D:\\other", profile: undefined, mode: "embed" },
    ]);
  });

  it("are taken at startup", async () => {
    store.set({ settings: { ...store.get().settings, pinned: ["/p"] } });
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "take_open_request" ? [{ dir: "/p", profile: null }] : null,
    );
    await installOpenRequests();
    expect(invoke).toHaveBeenCalledWith("take_open_request", {});
    expect(launches).toHaveLength(1);
  });
});
