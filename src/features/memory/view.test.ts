import { describe, expect, it } from "vitest";
import { joinPath, tilde } from "./view";

describe("joinPath", () => {
  it("resolves a link against the file's folder", () => {
    expect(joinPath("/Users/me/.claude/projects/x/memory", "a.md")).toBe("/Users/me/.claude/projects/x/memory/a.md");
    expect(joinPath("/Users/me/app/src", "../CLAUDE.md")).toBe("/Users/me/app/CLAUDE.md");
    expect(joinPath("/Users/me/app", "./docs/./x.md")).toBe("/Users/me/app/docs/x.md");
    expect(joinPath("C:\\code\\app", "..\\CLAUDE.md")).toBe("C:\\code\\CLAUDE.md");
    expect(joinPath("/a", "/abs/x.md")).toBe("/abs/x.md");
  });
});

describe("tilde", () => {
  it("writes the home folder as ~ and leaves other paths alone", () => {
    expect(tilde("/Users/me/.claude", "/Users/me")).toBe("~/.claude");
    expect(tilde("/Users/me", "/Users/me")).toBe("~");
    expect(tilde("/Users/meg/x", "/Users/me")).toBe("/Users/meg/x");
    expect(tilde("C:\\Users\\Me\\.claude\\rules", "C:\\Users\\me")).toBe("~\\.claude\\rules");
    expect(tilde("/opt/x", null)).toBe("/opt/x");
  });
});
