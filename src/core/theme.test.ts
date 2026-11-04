import { describe, expect, it } from "vitest";
import { appScheme, termScheme, zoomFor } from "./theme";

describe("interface size", () => {
  it("is a page zoom around 100%", () => {
    expect(zoomFor("small")).toBe(0.9);
    expect(zoomFor("default")).toBe(1);
    expect(zoomFor("large")).toBe(1.1);
    expect(zoomFor("larger")).toBe(1.25);
  });
});

describe("theme", () => {
  it("app follows the OS only on system", () => {
    expect(appScheme({ theme: "system" }, true)).toBe("dark");
    expect(appScheme({ theme: "system" }, false)).toBe("light");
    expect(appScheme({ theme: "light" }, true)).toBe("light");
    expect(appScheme({ theme: "dark" }, false)).toBe("dark");
  });

  it("terminals use the app's scheme or their own", () => {
    expect(termScheme({ theme: "light", terminalTheme: "app" }, true)).toBe("light");
    expect(termScheme({ theme: "system", terminalTheme: "app" }, true)).toBe("dark");
    expect(termScheme({ theme: "light", terminalTheme: "dark" }, false)).toBe("dark");
    expect(termScheme({ theme: "dark", terminalTheme: "light" }, true)).toBe("light");
  });
});
