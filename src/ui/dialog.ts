// In-app modal dialogs (themed, unlike OS message boxes). The first line of the text is the bold title,
// the rest is the explanation. Confirm buttons are named after the action; warnings get a red button.
// Enter = the default button, Esc = cancel, Tab stays inside the dialog.
//
//   if (await ask("Delete the project 'web'?\n\nIts folders go back to Ungrouped.", "Delete", "warning")) ...
//   const name = await input("New branch\nName for the new branch:", { value: "main" });

import { h } from "../core/dom";
import { animate, Spring } from "../core/motion";
import { type ButtonKind, button } from "./button";
import "./dialog.css";

export type DialogKind = "info" | "question" | "warning" | "error";

/** Splits dialog text into its title (first line) and body (the rest, runs of blank lines collapsed). */
export function splitMessage(text: string): { title: string; body: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const title = (lines.shift() ?? "").trim();
  const body = lines
    .join("\n")
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
  return { title, body };
}

/** The confirm button's text for an action caption, as the Windows app names it. */
export function confirmLabel(caption: string): string {
  const c = caption.trim();
  if (c === "" || c === "Claude Manager") return "OK";
  if (c === "Commit") return "Stage all & commit";
  if (c === "Close terminal") return "Close";
  return c;
}

export interface DialogButton<T extends string> {
  id: T;
  label: string;
  kind?: Extract<ButtonKind, "primary" | "secondary" | "danger">;
}

export interface ChooseOptions<T extends string> {
  /** Returned by Esc. */
  cancel: T;
  /** Returned by Enter, focused first, drawn bold. */
  primary: T;
  kind?: DialogKind;
}

interface OpenOptions<T extends string> extends ChooseOptions<T> {
  /** A one-line text field under the text, prefilled and selected. */
  field?: { value?: string; placeholder?: string };
}

let seq = 0;

function open<T extends string>(
  text: string,
  buttons: DialogButton<T>[],
  opts: OpenOptions<T>,
): Promise<{ id: T; value: string }> {
  const { title, body } = splitMessage(text);
  const restore = document.activeElement;
  const titleId = `dlg-title-${++seq}`;
  const field = opts.field
    ? h("input", {
        class: "dlg-input",
        type: "text",
        value: opts.field.value ?? "",
        placeholder: opts.field.placeholder ?? "",
        spellcheck: false,
        attrs: { "aria-labelledby": titleId },
      })
    : null;
  const row = h("div", { class: "dlg-buttons" });
  const box = h(
    "div",
    {
      class: `dlg dlg-${opts.kind ?? "info"}`,
      attrs: {
        role: opts.kind === "warning" || opts.kind === "error" ? "alertdialog" : "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
      },
    },
    h("h2", { class: "dlg-title", id: titleId }, title),
    body ? h("p", { class: "dlg-body" }, body) : null,
    field,
    row,
  );
  const backdrop = h("div", { class: "dlg-backdrop" }, box);
  (document.getElementById("overlay-root") ?? document.body).append(backdrop);

  let finish: (r: { id: T; value: string }) => void = () => {};
  const result = new Promise<{ id: T; value: string }>((resolve) => {
    finish = resolve;
  });
  const s = new Spring(0.22, 0.9, 0.003, 0.6);
  const draw = (v: number) => {
    backdrop.style.opacity = String(Math.min(1, v));
    box.style.transform = `scale(${0.96 + 0.04 * Math.min(1, v)})`;
  };
  let done = false;
  const close = (id: T) => {
    if (done) return;
    done = true;
    box.removeAttribute("aria-modal"); // app shortcuts work again while it fades out
    backdrop.style.pointerEvents = "none";
    animate(s, 0, draw, () => backdrop.remove());
    if (restore instanceof HTMLElement) restore.focus({ preventScroll: true });
    finish({ id, value: field?.value ?? "" });
  };

  const els = buttons.map((b) => {
    const el = button({ label: b.label, kind: b.kind ?? "secondary", onClick: () => close(b.id) });
    el.dataset.id = b.id;
    if (b.id === opts.primary) el.classList.add("dlg-primary");
    return el;
  });
  row.append(...els);

  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(opts.cancel);
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      // a focused button handles Enter itself (it may not be the default one)
      e.preventDefault();
      close(opts.primary);
    } else if (e.key === "Tab") {
      const focusable: HTMLElement[] = field ? [field, ...els] : els;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  });
  // a click on the backdrop must not take focus out of the dialog
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) e.preventDefault();
  });

  draw(s.value);
  animate(s, 1, draw);
  if (field) {
    field.focus();
    field.select();
  } else els.find((b) => b.dataset.id === opts.primary)?.focus();
  return result;
}

/** A dialog with any buttons, in the order given (Cancel first, the default last). Resolves with the chosen id. */
export async function choose<T extends string>(
  text: string,
  buttons: DialogButton<T>[],
  opts: ChooseOptions<T>,
): Promise<T> {
  return (await open(text, buttons, opts)).id;
}

/** Yes/no question. The confirm button is named after `caption` (see confirmLabel); warnings make it red. */
export async function ask(text: string, caption = "", kind: "question" | "warning" = "question"): Promise<boolean> {
  const answer = await choose(
    text,
    [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: confirmLabel(caption), kind: kind === "warning" ? "danger" : "primary" },
    ],
    { cancel: "cancel", primary: "ok", kind },
  );
  return answer === "ok";
}

/** Information with a single OK button. */
export async function message(text: string, kind: "info" | "warning" | "error" = "info"): Promise<void> {
  await choose(text, [{ id: "ok", label: "OK", kind: "primary" }], { cancel: "ok", primary: "ok", kind });
}

/** One-line text prompt, prefilled and selected. Resolves with the text as typed, or null when cancelled. */
export async function input(
  text: string,
  opts: { value?: string; placeholder?: string; okLabel?: string } = {},
): Promise<string | null> {
  const { id, value } = await open(
    text,
    [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: opts.okLabel ?? "OK", kind: "primary" },
    ],
    { cancel: "cancel", primary: "ok", kind: "question", field: { value: opts.value, placeholder: opts.placeholder } },
  );
  return id === "ok" ? value : null;
}
