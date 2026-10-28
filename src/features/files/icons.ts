// Icons only the Files view uses (16x16 strokes, currentColor), as fresh elements.

function svg(body: string): Element {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  return t.content.firstElementChild as Element;
}

export const newFileIcon = (): Element =>
  svg(`<path d="M9 1.5H4v13h5M9 1.5l3 3V8M9 1.5v3h3M12 10v4.5M9.75 12.25h4.5"/>`);

export const newFolderIcon = (): Element =>
  svg(`<path d="M8 13.5H2.5a1 1 0 0 1-1-1v-9h4.2L7.2 5h7.3v3.5M12 9.5V14M9.75 11.75h4.5"/>`);

/** Ignored files are shown. */
export const eyeIcon = (): Element =>
  svg(`<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>`);

/** Ignored files are hidden. */
export const eyeOffIcon = (): Element =>
  svg(
    `<path d="M2.5 2.5l11 11M6.6 3.7A6.6 6.6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.7 2.2M10.6 11.9a6 6 0 0 1-2.6.6C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.6-3.1M6.6 6.6a2 2 0 0 0 2.8 2.8"/>`,
  );

export const collapseIcon = (): Element =>
  svg(`<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 8h5"/>`);
