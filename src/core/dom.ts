// Small DOM helpers. Text from sessions, paths and profiles is untrusted: it reaches innerHTML only
// through html`` (which escapes every value) or esc().

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Markup that is already safe (built by html`` or trusted constants such as icons). */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Marks a trusted constant string as markup. Never pass data through this. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

type HtmlValue = string | number | boolean | null | undefined | SafeHtml | HtmlValue[];

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return esc(String(value));
}

/** Template tag: html`<b>${name}</b>` escapes `name`; nested html`` results and raw() pass through. */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new SafeHtml(out);
}

export function setHtml(el: Element, markup: SafeHtml): void {
  el.innerHTML = markup.value;
}

/** Required element: throws with the selector when it is missing (a broken shell is a bug, not a state). */
export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style" | "dataset">> & {
  class?: string;
  style?: Partial<CSSStyleDeclaration>;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean>;
};

/** Creates an element: h("button", { class: "btn", onclick }, "Save"). Strings become text nodes. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, style, dataset, attrs, ...rest } = props;
  if (cls) el.className = cls;
  if (style) Object.assign(el.style, style);
  if (dataset) Object.assign(el.dataset, dataset);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  Object.assign(el, rest);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Parses trusted markup (icons, html`` results) into one element. */
export function fragment(markup: SafeHtml): Element {
  const t = document.createElement("template");
  t.innerHTML = markup.value.trim();
  const el = t.content.firstElementChild;
  if (!el) throw new Error("fragment: empty markup");
  return el;
}

/**
 * Keyed list update: keeps the DOM node of every item whose key survives, creates nodes for new keys,
 * removes nodes for gone keys, and puts everything in order. Focus and running animations on kept
 * nodes survive a refresh. Nodes are tracked by `data-key`.
 */
export function reconcile<T>(
  parent: Element,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update: (el: HTMLElement, item: T) => void,
): void {
  const wanted = new Set(items.map(key));
  const existing = new Map<string, HTMLElement>();
  for (const child of [...parent.children]) {
    if (!(child instanceof HTMLElement) || child.dataset.key === undefined) continue;
    // stale nodes go first, so kept nodes that are already in order are never moved (moving one blurs it)
    if (wanted.has(child.dataset.key)) existing.set(child.dataset.key, child);
    else child.remove();
  }
  let cursor: ChildNode | null = parent.firstChild;
  const skipUnkeyed = () => {
    // nodes that are not part of the list (e.g. a highlight pill) stay where they are
    while (cursor && !(cursor instanceof HTMLElement && cursor.dataset.key !== undefined)) cursor = cursor.nextSibling;
  };
  skipUnkeyed();
  for (const item of items) {
    const k = key(item);
    let el = existing.get(k);
    if (!el) {
      el = create(item);
      el.dataset.key = k;
    }
    update(el, item);
    if (el === cursor) {
      cursor = el.nextSibling;
      skipUnkeyed();
    } else parent.insertBefore(el, cursor);
  }
}

/** Delegated event: runs `handler` for events inside `root` whose target is within `selector`. */
export function delegate<K extends keyof HTMLElementEventMap>(
  root: HTMLElement,
  type: K,
  selector: string,
  handler: (e: HTMLElementEventMap[K], match: HTMLElement) => void,
): () => void {
  const listener = (e: HTMLElementEventMap[K]) => {
    const match = (e.target as Element | null)?.closest<HTMLElement>(selector);
    if (match && root.contains(match)) handler(e, match);
  };
  root.addEventListener(type, listener);
  return () => root.removeEventListener(type, listener);
}

/** CSS.escape for attribute selectors built from data (paths contain quotes and backslashes). */
export function cssEsc(value: string): string {
  return CSS.escape(value);
}

/** Resolves after the next paint. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
