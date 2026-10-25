// Short notices in the bottom-right corner (errors from backend calls, confirmations).
// toast(text) shows one; it hides itself after `timeout` ms (errors stay longer) or when clicked away.

import { h } from "../core/dom";
import { animate, Spring } from "../core/motion";
import "./toast.css";

export type ToastKind = "info" | "error" | "success";

export interface ToastOptions {
  kind?: ToastKind;
  /** ms before it hides; 0 keeps it until closed. Default 4 s, errors 8 s. */
  timeout?: number;
  action?: { label: string; run: () => void };
}

export interface ToastHandle {
  close(): void;
}

const MAX_VISIBLE = 4;

function stack(): HTMLElement {
  let el = document.querySelector<HTMLElement>(".toast-stack");
  if (!el) {
    el = h("div", { class: "toast-stack", attrs: { role: "status", "aria-live": "polite" } });
    (document.getElementById("overlay-root") ?? document.body).append(el);
  }
  return el;
}

export function toast(text: string, opts: ToastOptions = {}): ToastHandle {
  const kind = opts.kind ?? "info";
  const root = stack();
  const el = h("div", { class: `toast toast-${kind}` }, h("span", { class: "toast-text" }, text));
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const s = new Spring(0.3, 0.86, 0.003);
  const draw = (v: number) => {
    el.style.opacity = String(Math.max(0, Math.min(1, v)));
    el.style.transform = `translateY(${(1 - v) * 10}px)`;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    animate(s, 0, draw, () => el.remove());
  };
  if (opts.action) {
    const { label, run } = opts.action;
    el.append(
      h("button", {
        class: "toast-action",
        type: "button",
        textContent: label,
        onclick: () => {
          close();
          run();
        },
      }),
    );
  }
  el.append(
    h("button", {
      class: "toast-close",
      type: "button",
      textContent: "×",
      onclick: close,
      attrs: { "aria-label": "Dismiss" },
    }),
  );
  root.append(el);
  while (root.children.length > MAX_VISIBLE) root.firstElementChild?.remove();
  draw(0);
  animate(s, 1, draw);
  const timeout = opts.timeout ?? (kind === "error" ? 8000 : 4000);
  if (timeout > 0) timer = setTimeout(close, timeout);
  return { close };
}
