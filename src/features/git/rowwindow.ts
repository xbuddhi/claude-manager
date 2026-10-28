// The rows on screen of a virtualized view, kept by line index: a scroll frame builds only the rows coming
// into the window and removes the ones leaving it, instead of rebuilding every visible row. Rows stay in
// index order in the DOM, so a selection across rows copies in order.

export interface RowWindow {
  /** Shows rows [first, last). */
  update(first: number, last: number): void;
  /** The rows' content changed: the next update builds them all again. */
  invalidate(): void;
}

export function createRowWindow(inner: HTMLElement, build: (i: number) => HTMLElement): RowWindow {
  const rows = new Map<number, HTMLElement>();
  // the window on screen: [from, to); empty after invalidate
  let from = 0;
  let to = 0;

  const make = (i: number) => {
    const el = build(i);
    rows.set(i, el);
    return el;
  };
  const drop = (i: number) => {
    rows.get(i)?.remove();
    rows.delete(i);
  };

  return {
    update(first, last) {
      if (last <= first || to <= from || first >= to || last <= from) {
        // nothing kept: build the window whole
        rows.clear();
        const out: HTMLElement[] = [];
        for (let i = first; i < last; i++) out.push(make(i));
        inner.replaceChildren(...out);
      } else {
        for (let i = from; i < first; i++) drop(i);
        for (let i = last; i < to; i++) drop(i);
        const head: HTMLElement[] = [];
        for (let i = first; i < from; i++) head.push(make(i));
        if (head.length) inner.prepend(...head);
        const tail: HTMLElement[] = [];
        for (let i = to; i < last; i++) tail.push(make(i));
        if (tail.length) inner.append(...tail);
      }
      from = first;
      to = Math.max(first, last);
    },
    invalidate() {
      from = to = 0;
    },
  };
}
