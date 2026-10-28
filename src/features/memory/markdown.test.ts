import { describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "./markdown";

const md = [
  "# Global Rules",
  "",
  "Do **what** was *asked* with `code` and a [note](notes/a.md).",
  "",
  "- one",
  "- [x] done",
  "",
  "1. first",
  "",
  "> a quote",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "<script>alert(1)</script>",
  "",
  "Tom &amp; Jerry \\*not em\\*",
].join("\n");

describe("renderMarkdown", () => {
  it("renders a memory file as a document", async () => {
    const doc = await renderMarkdown(md, () => {});
    expect(doc.querySelector("h1")?.textContent).toBe("Global Rules");
    const p = doc.querySelector("p") as HTMLElement;
    expect(p.querySelector("strong")?.textContent).toBe("what");
    expect(p.querySelector("em")?.textContent).toBe("asked");
    expect(p.querySelector("code")?.textContent).toBe("code");
    expect(p.textContent).toBe("Do what was asked with code and a note.");
    expect([...doc.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["one", "done"]);
    expect((doc.querySelector("li input") as HTMLInputElement).checked).toBe(true);
    expect(doc.querySelector("ol > li")?.textContent).toBe("first");
    expect(doc.querySelector("blockquote")?.textContent).toBe("a quote");
    expect(doc.querySelector("pre code")?.textContent).toBe("const a = 1;");
    expect([...doc.querySelectorAll("th, td")].map((c) => c.textContent?.trim())).toEqual(["a", "b", "1", "2"]);
    expect(doc.textContent).toContain("Tom & Jerry *not em*");
  });

  it("shows raw HTML as code and never as elements", async () => {
    const doc = await renderMarkdown(md, () => {});
    expect(doc.querySelector("script")).toBeNull();
    expect([...doc.querySelectorAll("pre code")].some((c) => c.textContent?.includes("<script>"))).toBe(true);
  });

  it("hands clicked links to the caller", async () => {
    const onLink = vi.fn();
    const doc = await renderMarkdown(md, onLink);
    (doc.querySelector("a") as HTMLAnchorElement).click();
    expect(onLink).toHaveBeenCalledWith("notes/a.md");
  });
});
