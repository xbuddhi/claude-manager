import { describe, expect, it } from "vitest";
import { claudeStatus, parseScrollback, updateText } from "./settings";

describe("settings sheet helpers", () => {
  it("keep scrollback within 1000-50000", () => {
    expect(parseScrollback("5000")).toBe(5000);
    expect(parseScrollback(" 20000 ")).toBe(20000);
    expect(parseScrollback("10")).toBe(1000);
    expect(parseScrollback("999999")).toBe(50000);
    expect(parseScrollback("")).toBeNull();
    expect(parseScrollback("lots")).toBeNull();
  });

  it("describe the claude path", () => {
    expect(claudeStatus("C:\\tools\\claude.exe")).toBe("Claude Code: C:\\tools\\claude.exe (found)");
    expect(claudeStatus(null)).toBe("Claude Code: not found");
  });

  it("describe every update check result", () => {
    expect(updateText({ kind: "disabled" })).toBe("Updates are not turned on in this build.");
    expect(updateText({ kind: "current" })).toBe("Claude Manager is up to date.");
    expect(updateText({ kind: "available", version: "1.2.0" })).toBe("Version 1.2.0 is available.");
    expect(updateText({ kind: "failed", message: "offline" })).toBe("Could not check for updates: offline");
  });
});
