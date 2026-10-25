import { describe, expect, it } from "vitest";
import { normPath, pathKey, samePath } from "./paths";

// the same cases as core::paths tests in Rust, so both sides build identical keys
describe("normPath", () => {
  it("trims trailing separators but keeps roots", () => {
    expect(normPath("/Users/x/")).toBe("/Users/x");
    expect(normPath("C:\\code\\app\\\\")).toBe("C:\\code\\app");
    expect(normPath("/")).toBe("/");
    expect(normPath("C:\\")).toBe("C:\\");
    expect(normPath("C:/")).toBe("C:/");
  });
});

describe("pathKey", () => {
  it("folds case and separators on Windows", () => {
    expect(pathKey("C:/Code/App", "windows")).toBe(pathKey("c:\\code\\app\\", "windows"));
    expect(pathKey("C:/Code/App/", "windows")).toBe("c:\\code\\app");
  });

  it("folds case on macOS only", () => {
    expect(pathKey("/Users/X/Proj/", "macos")).toBe("/users/x/proj");
    expect(pathKey("/Users/X/Proj/", "linux")).toBe("/Users/X/Proj");
    expect(samePath("/Users/X/Proj", "/users/x/proj/", "macos")).toBe(true);
    expect(samePath("/Users/X/Proj", "/users/x/proj", "linux")).toBe(false);
  });
});
