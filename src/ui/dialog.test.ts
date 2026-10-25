import { afterEach, describe, expect, it } from "vitest";
import { ask, choose, confirmLabel, input, splitMessage } from "./dialog";

const dialogs = () =>
  [...document.querySelectorAll<HTMLElement>(".dlg-backdrop")].filter((d) => d.style.pointerEvents !== "none");
const top = () => {
  const open = dialogs();
  const d = open[open.length - 1];
  if (!d) throw new Error("no dialog open");
  return d;
};
const buttons = () => [...top().querySelectorAll<HTMLButtonElement>(".dlg-buttons button")];
const pressKey = (key: string, target: Element = document.activeElement ?? top()) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

afterEach(() => {
  document.body.replaceChildren();
});

describe("confirmLabel", () => {
  it("names the confirm button after the action", () => {
    expect(confirmLabel("Delete")).toBe("Delete");
    expect(confirmLabel("Discard")).toBe("Discard");
    expect(confirmLabel("Commit")).toBe("Stage all & commit");
    expect(confirmLabel("Close terminal")).toBe("Close");
  });

  it("falls back to OK for an empty or app-name caption", () => {
    expect(confirmLabel("")).toBe("OK");
    expect(confirmLabel("Claude Manager")).toBe("OK");
  });
});

describe("splitMessage", () => {
  it("uses the first line as the title and collapses runs of blank lines", () => {
    expect(splitMessage("Close this terminal?\n\n\n\nchat\nproject\n\nIt can be resumed.")).toEqual({
      title: "Close this terminal?",
      body: "chat\nproject\n\nIt can be resumed.",
    });
    expect(splitMessage("Just a title")).toEqual({ title: "Just a title", body: "" });
  });
});

describe("ask", () => {
  it("puts Cancel left of the named confirm button, red for warnings", async () => {
    const answer = ask("Delete the project 'web'?\n\nNo folders are deleted.", "Delete", "warning");
    const [cancel, confirm] = buttons();
    expect(cancel?.textContent).toBe("Cancel");
    expect(confirm?.textContent).toBe("Delete");
    expect(confirm?.classList.contains("btn-danger")).toBe(true);
    expect(top().querySelector(".dlg-title")?.textContent).toBe("Delete the project 'web'?");
    expect(top().querySelector('[role="alertdialog"]')).not.toBeNull();
    confirm?.click();
    expect(await answer).toBe(true);
  });

  it("answers no on Escape and yes on Enter", async () => {
    const no = ask("Close this terminal?", "Close terminal");
    expect(buttons()[1]?.textContent).toBe("Close");
    pressKey("Escape");
    expect(await no).toBe(false);

    const yes = ask("Proceed?");
    pressKey("Enter", top().querySelector(".dlg") ?? top());
    expect(await yes).toBe(true);
  });
});

describe("choose", () => {
  it("focuses the primary button and resolves with the clicked id", async () => {
    const pick = choose(
      "2 terminals are still open",
      [
        { id: "cancel", label: "Cancel" },
        { id: "close", label: "Close terminals", kind: "danger" },
        { id: "keep", label: "Keep running", kind: "primary" },
      ],
      { cancel: "cancel", primary: "keep", kind: "warning" },
    );
    expect(document.activeElement?.textContent).toBe("Keep running");
    buttons()[1]?.click();
    expect(await pick).toBe("close");
  });
});

describe("input", () => {
  it("returns the typed text on OK and null on Cancel", async () => {
    const named = input("New branch\nName for the new branch:", { value: "main" });
    const field = top().querySelector<HTMLInputElement>(".dlg-input");
    expect(field?.value).toBe("main");
    if (field) field.value = "feature";
    pressKey("Enter", field ?? top());
    expect(await named).toBe("feature");

    const cancelled = input("Rename");
    buttons()[0]?.click();
    expect(await cancelled).toBeNull();
  });
});
