import { describe, expect, it } from "vitest";
import { shellLabels } from "./shellpanel";

describe("shellLabels", () => {
  it("numbers the same shell from its second one on", () => {
    const items = [
      { id: 1, name: "zsh" },
      { id: 2, name: "zsh" },
      { id: 3, name: "bash" },
      { id: 4, name: "zsh" },
    ];
    expect(shellLabels(items)).toEqual(["zsh", "zsh 2", "bash", "zsh 3"]);
  });
});
