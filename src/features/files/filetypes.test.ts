import { describe, expect, it } from "vitest";
import { fileType } from "./filetypes";

describe("fileType", () => {
  it("goes by extension, in any case", () => {
    expect(fileType("main.ts")?.label).toBe("TS");
    expect(fileType("types.MTS")?.label).toBe("TS");
    expect(fileType("App.tsx")).toEqual({ label: "TX", color: "--syn-purple" });
    expect(fileType("App.jsx")?.label).toBe("JX");
    expect(fileType("a.test.js")?.label).toBe("JS");
    expect(fileType("notes.md")).toEqual({ label: "M↓", color: "--syn-purple" });
  });

  it("knows some files by their whole name first", () => {
    expect(fileType("CLAUDE.md")?.label).toBe("✱");
    expect(fileType("package.json")?.color).toBe("--syn-green");
    expect(fileType("Dockerfile")?.label).toBe("D");
    expect(fileType(".env.local")?.label).toBe("≡");
  });

  it("leaves unknown and extensionless files plain", () => {
    expect(fileType("data.xyz")).toBeNull();
    expect(fileType("README")).toBeNull();
    expect(fileType(".bashrc")).toBeNull();
  });
});
