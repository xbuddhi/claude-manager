import { describe, expect, it } from "vitest";
import { appScheme, termScheme } from "./theme";

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
