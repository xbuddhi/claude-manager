import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store, type TermInfo } from "../../core/store";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  ask: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", async (orig) => ({
  ...(await orig<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/plugin-log", () => {
  const ok = () => Promise.resolve();
  return { error: ok, warn: ok, info: ok, debug: ok };
});
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("../../ui/dialog", () => ({ ask: mocks.ask }));

const {
  BANNER_ID,
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  checkForUpdate,
  isUnavailable,
  liveTerminals,
  progressText,
  resetForTests,
  restartQuestion,
  restartToUpdate,
  startChecks,
} = await import("./updater");
const { checkNow } = await import("./api");

const banner = () => document.querySelector<HTMLElement>(`[data-banner="${BANNER_ID}"]`);
const bannerText = () => banner()?.querySelector(".banner-text")?.textContent ?? null;

function fakeUpdate(version: string, events: DownloadEvent[] = [], fail?: Error) {
  const update = {
    version,
    currentVersion: "1.0.0",
    close: vi.fn(() => Promise.resolve()),
    downloadAndInstall: vi.fn(async (onEvent?: (e: DownloadEvent) => void) => {
      for (const e of events) onEvent?.(e);
      if (fail) throw fail;
    }),
  };
  return update as typeof update & Update;
}

function term(patch: Partial<TermInfo>): TermInfo {
  return {
    id: 1,
    ptyId: 1,
    pid: 10,
    title: "",
    sub: "",
    dir: "",
    profile: "",
    sessionId: null,
    exited: false,
    ...patch,
  };
}

beforeEach(() => {
  resetForTests();
  store.set({ terminals: [] });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  mocks.check.mockReset();
  mocks.relaunch.mockReset();
  mocks.ask.mockReset();
});

describe("helpers", () => {
  it("recognises a build without the updater plugin", () => {
    expect(isUnavailable("plugin updater not found")).toBe(true);
    expect(isUnavailable(new Error("updater.check not allowed. Plugin not found"))).toBe(true);
    expect(isUnavailable("error sending request for url (https://github.com/...)")).toBe(false);
  });

  it("counts only terminals whose claude still runs", () => {
    expect(
      liveTerminals([term({ id: 1 }), term({ id: 2, exited: true }), term({ id: 3, ptyId: null }), term({ id: 4 })]),
    ).toBe(2);
  });

  it("words the restart question for one or more sessions", () => {
    expect(restartQuestion("1.2.0", 1)).toContain("ends 1 Claude session that is running");
    expect(restartQuestion("1.2.0", 3)).toMatch(/^Restart to update to v1\.2\.0\?\n.*ends 3 Claude sessions/);
  });

  it("shows percent when the size is known, megabytes otherwise", () => {
    expect(progressText("1.2.0", 0, undefined)).toMatch(/^Downloading update v1\.2\.0…\n/);
    expect(progressText("1.2.0", 512, 1024)).toMatch(/^Downloading update v1\.2\.0… 50%\n/);
    expect(progressText("1.2.0", 4096, 1024)).toMatch(/… 100%\n/);
    expect(progressText("1.2.0", 3 * 1048576, undefined)).toMatch(/… 3\.0 MB\n/);
  });
});

describe("checking", () => {
  it("reports disabled and stops asking when the plugin is not registered", async () => {
    mocks.check.mockRejectedValue("plugin updater not found");
    expect(await checkNow()).toEqual({ kind: "disabled" });
    expect(await checkNow()).toEqual({ kind: "disabled" });
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(banner()).toBeNull();
  });

  it("reports a failed check without a banner", async () => {
    mocks.check.mockRejectedValue(new Error("network down"));
    expect(await checkNow()).toEqual({ kind: "failed", message: "network down" });
    expect(banner()).toBeNull();
  });

  it("reports current and removes an old banner", async () => {
    mocks.check.mockResolvedValueOnce(fakeUpdate("1.1.0"));
    await checkNow();
    expect(banner()).not.toBeNull();
    mocks.check.mockResolvedValueOnce(null);
    expect(await checkNow()).toEqual({ kind: "current" });
    expect(banner()).toBeNull();
  });

  it("shows the available version with a restart action", async () => {
    mocks.check.mockResolvedValue(fakeUpdate("1.1.0"));
    expect(await checkNow()).toEqual({ kind: "available", version: "1.1.0" });
    expect(bannerText()).toContain("Update available: v1.1.0");
    expect(banner()?.querySelector(".banner-action")?.textContent).toBe("Restart to update");
  });

  it("shares one check between callers and releases the replaced result", async () => {
    const first = fakeUpdate("1.1.0");
    mocks.check.mockResolvedValueOnce(first).mockResolvedValueOnce(fakeUpdate("1.2.0"));
    const [a, b] = await Promise.all([checkNow(), checkNow()]);
    expect(a).toEqual(b);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await checkNow();
    expect(first.close).toHaveBeenCalled();
  });

  it("does not bring back a dismissed banner on the daily check, but a manual check does", async () => {
    mocks.check.mockResolvedValue(fakeUpdate("1.1.0"));
    await checkForUpdate(true);
    banner()?.remove();
    await checkForUpdate(true);
    expect(banner()).toBeNull();
    await checkNow();
    expect(banner()).not.toBeNull();
  });

  it("checks after startup and then daily", async () => {
    vi.useFakeTimers();
    mocks.check.mockResolvedValue(null);
    const stop = startChecks();
    expect(mocks.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("restart to update", () => {
  const events: DownloadEvent[] = [
    { event: "Started", data: { contentLength: 200 } },
    { event: "Progress", data: { chunkLength: 100 } },
    { event: "Progress", data: { chunkLength: 100 } },
    { event: "Finished" },
  ];

  it("downloads, installs and relaunches without asking when nothing runs", async () => {
    const update = fakeUpdate("1.1.0", events);
    await restartToUpdate(update);
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(update.downloadAndInstall).toHaveBeenCalled();
    expect(mocks.relaunch).toHaveBeenCalled();
    expect(bannerText()).toContain("Installing update v1.1.0");
  });

  it("asks first when sessions run, and does nothing when cancelled", async () => {
    store.set({ terminals: [term({})] });
    mocks.ask.mockResolvedValue(false);
    const update = fakeUpdate("1.1.0", events);
    await restartToUpdate(update);
    expect(mocks.ask).toHaveBeenCalledWith(expect.stringContaining("ends 1 Claude session"), "Restart", "warning");
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(mocks.relaunch).not.toHaveBeenCalled();
  });

  it("offers to try again when the install fails", async () => {
    const update = fakeUpdate("1.1.0", events.slice(0, 2), new Error("signature mismatch"));
    await restartToUpdate(update);
    expect(mocks.relaunch).not.toHaveBeenCalled();
    expect(bannerText()).toContain("could not be installed");
    expect(bannerText()).toContain("signature mismatch");
    expect(banner()?.querySelector(".banner-action")?.textContent).toBe("Try again");
  });
});
